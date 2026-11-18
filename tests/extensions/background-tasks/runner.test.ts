import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  inspectJob,
  type Job,
  type JobSpec,
  jobDir,
  readJob,
  saveJob,
  startJob,
  stopJob,
} from "../../../extensions/background-tasks/runner.ts";

const exec = promisify(execFile);
const runnerUrl = new URL(
  "../../../extensions/background-tasks/runner.ts",
  import.meta.url,
).href;
const session = "00112233-4455-6677-8899-aabbccddeeff";
const otherSession = "10112233-4455-6677-8899-aabbccddeeff";
const options = { skip: process.platform === "win32", timeout: 20_000 };

async function client<T>(code: string, ...args: string[]): Promise<T> {
  const { stdout } = await exec(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { startJob, inspectJob, stopJob } from ${JSON.stringify(runnerUrl)}; ${code}`,
      ...args,
    ],
    { timeout: 3_000 },
  );
  return JSON.parse(stdout);
}

async function launch(
  root: string,
  spec: Omit<JobSpec, "cwd">,
): Promise<string> {
  const job = await client<Job>(
    "console.log(JSON.stringify(await startJob(process.argv[1], process.argv[2], JSON.parse(process.argv[3]))));",
    root,
    session,
    JSON.stringify({ ...spec, cwd: root }),
  );
  return jobDir(root, session, job.id);
}

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const result = read();
    if (result !== undefined) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for background job");
}

function completed(dir: string): Promise<Job> {
  return until(() => {
    const job = readJob(dir);
    if (job.finishedAt) return job;
  });
}

test(
  "the job writes output and exit status after its launcher exits",
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
    try {
      const dir = await launch(root, {
        command:
          "while [ ! -e proceed ]; do sleep 0.05; done; printf 'out\\n'; printf 'err\\n' >&2; exit 7",
        timeoutMs: 2_000,
      });
      // Only release the job once the independent launcher has already exited.
      await exec("touch", [join(root, "proceed")]);
      await completed(dir);
      const { job, state } = await client<
        Awaited<ReturnType<typeof inspectJob>>
      >("console.log(JSON.stringify(await inspectJob(process.argv[1])));", dir);
      assert.equal(state, "exited");
      assert.equal(job.exitCode, 7);
      assert.equal(readFileSync(join(dir, "output.log"), "utf8"), "out\nerr\n");
      const events = readFileSync(join(dir, "supervisor.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event);
      assert.deepEqual(events, [
        "supervisor_started",
        "command_started",
        "command_exited",
        "job_finished",
      ]);
      assert.equal(dir, join(root, session, job.id));
      assert.equal(existsSync(jobDir(root, otherSession, job.id)), false);
      assert.throws(
        () => jobDir(root, "../other-session", job.id),
        /Invalid Pi session ID/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a new client reconnects and stops a job with a TERM-resistant child",
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
    let dir: string | undefined;
    try {
      dir = await launch(root, {
        command:
          "(trap '' TERM; while :; do printf '.\\n'; sleep 0.05; done) & wait",
        timeoutMs: 12_000,
      });
      const output = join(dir, "output.log");
      await until(() =>
        existsSync(output) && readFileSync(output, "utf8").includes(".")
          ? true
          : undefined,
      );
      const result = await client<{ state: string; stopped: boolean }>(
        "const dir = process.argv[1]; console.log(JSON.stringify({ state: (await inspectJob(dir)).state, stopped: await stopJob(dir) }));",
        dir,
      );
      assert.deepEqual(result, { state: "running", stopped: true });
      assert.equal(readJob(dir).state, "stopping");
      assert.equal((await completed(dir)).state, "stopped");
      await delay(100);
      const finalOutput = readFileSync(output, "utf8");
      await delay(150);
      assert.equal(readFileSync(output, "utf8"), finalOutput);
    } finally {
      if (dir && !readJob(dir).finishedAt) {
        await stopJob(dir);
        await completed(dir);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the job is finished and cannot be stopped while a background child still runs",
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
    const release = join(root, "release-child");
    const marker = "child wrote after shell exit\n";
    try {
      const dir = await launch(root, {
        command:
          "(i=0; while [ ! -e release-child ] && [ \"$i\" -lt 100 ]; do sleep 0.05; i=$((i+1)); done; [ -e release-child ] && printf 'child wrote after shell exit\\n') & exit 0",
      });
      const output = join(dir, "output.log");
      const result = await completed(dir);
      assert.equal(result.state, "exited");
      assert.equal(result.exitCode, 0);
      assert.equal(await stopJob(dir), false);
      assert.equal(readFileSync(output, "utf8"), "");

      writeFileSync(release, "");
      await until(() =>
        readFileSync(output, "utf8") === marker ? true : undefined,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a timeout is recorded separately from a user stop", options, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
  try {
    const job = await startJob(root, session, {
      cwd: root,
      command: "sleep 60",
      timeoutMs: 50,
    });
    const dir = jobDir(root, session, job.id);
    assert.equal((await completed(dir)).state, "timed_out");
    assert.equal(await stopJob(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a command that cannot start records its error and uses the default timeout",
  options,
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
    try {
      const job = await startJob(root, session, {
        cwd: join(root, "missing"),
        command: "true",
      });
      assert.equal(job.timeoutMs, 30 * 60_000);
      const result = await completed(jobDir(root, session, job.id));
      assert.equal(result.state, "failed");
      assert.match(result.error ?? "", /ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "an unreachable supervisor without a result is unknown and cannot receive a stop",
  options,
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
    try {
      saveJob(dir, {
        id: "test-job",
        command: "true",
        cwd: dir,
        timeoutMs: null,
        socketPath: join(dir, "missing.sock"),
        createdAt: new Date().toISOString(),
        state: "running",
      });
      assert.equal((await inspectJob(dir)).state, "unknown");
      assert.equal(await stopJob(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
