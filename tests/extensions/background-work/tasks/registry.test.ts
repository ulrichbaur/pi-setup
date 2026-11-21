import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  handOver,
  JobRegistry,
  takeOver,
} from "../../../../extensions/background-work/tasks/registry.ts";
import {
  DEFAULT_TIMEOUT_MS,
  readJob,
} from "../../../../extensions/background-work/tasks/runner.ts";
import { withTempDir } from "../../../helpers.ts";
import { running, session, until } from "./fake-jobs.ts";

const options = { skip: process.platform === "win32", timeout: 20_000 };
const registryUrl = new URL(
  "../../../../extensions/background-work/tasks/registry.ts",
  import.meta.url,
).href;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a job records its output and exit status", options, async () => {
  await withTempDir("pi-bg-registry-", async (root) => {
    const registry = new JobRegistry();
    const changes: string[] = [];
    registry.subscribe((job) => changes.push(job.state));
    const { job, dir } = await registry.start(root, session, {
      cwd: root,
      command: "printf 'out\\n'; printf 'err\\n' >&2; exit 7",
    });
    assert.equal(job.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.ok(registry.owns(job.id));
    await until(() => readJob(dir).finishedAt !== undefined);
    const finished = readJob(dir);
    assert.equal(finished.state, "exited");
    assert.equal(finished.exitCode, 7);
    assert.equal(readFileSync(join(dir, "output.log"), "utf8"), "out\nerr\n");
    assert.equal(registry.owns(job.id), false);
    assert.deepEqual(registry.active(), []);
    assert.equal(changes.at(-1), "exited");
    assert.equal(registry.stop(job.id), false);
  });
});

test(
  "a stop escalates past a child that ignores SIGTERM",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      const registry = new JobRegistry();
      const dir = await running(
        registry,
        root,
        'sh -c \'trap "" TERM; echo $$ > child.pid; while :; do printf ".\\n"; sleep 0.05; done\' & wait',
      );
      const output = join(dir, "output.log");
      await until(() => readFileSync(output, "utf8").includes("."));
      const child = Number(readFileSync(join(root, "child.pid"), "utf8"));
      const startedAt = Date.now();
      assert.equal(registry.stop(readJob(dir).id), true);
      assert.equal(readJob(dir).state, "stopping");
      const job = await registry.waitForEnd(readJob(dir).id, 8_000);
      assert.equal(job?.state, "stopped");
      // The child outlasts SIGTERM, so it ends only at the grace period.
      assert.ok(Date.now() - startedAt >= 4_500);
      assert.equal(alive(child), false);
      await delay(100);
      const final = readFileSync(output, "utf8");
      await delay(150);
      assert.equal(readFileSync(output, "utf8"), final);
    });
  },
);

test("a stop ends as soon as the job's processes exit", options, async () => {
  await withTempDir("pi-bg-registry-", async (root) => {
    const registry = new JobRegistry();
    const dir = await running(registry, root, "sleep 30");
    const startedAt = Date.now();
    assert.equal(registry.stop(readJob(dir).id), true);
    const job = await registry.waitForEnd(readJob(dir).id, 8_000);
    assert.equal(job?.state, "stopped");
    assert.equal(job?.signal, "SIGTERM");
    assert.ok(Date.now() - startedAt < 2_000);
  });
});

test(
  "a finished job releases children the shell left running",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      const registry = new JobRegistry();
      const { job, dir } = await registry.start(root, session, {
        cwd: root,
        command: "(sleep 0.3; printf late > late.txt) & exit 0",
      });
      await until(() => readJob(dir).finishedAt !== undefined);
      assert.equal(readJob(dir).state, "exited");
      assert.equal(registry.stop(job.id), false);
      await until(() => existsSync(join(root, "late.txt")));
    });
  },
);

test("a timeout is recorded apart from a stop", options, async () => {
  await withTempDir("pi-bg-registry-", async (root) => {
    const registry = new JobRegistry();
    const { job } = await registry.start(root, session, {
      cwd: root,
      command: "sleep 60",
      timeoutMs: 50,
    });
    const ended = await registry.waitForEnd(job.id, 8_000);
    assert.equal(ended?.state, "timed_out");
  });
});

test("a command that cannot start records its error", options, async () => {
  await withTempDir("pi-bg-registry-", async (root) => {
    const registry = new JobRegistry();
    const { dir } = await registry.start(root, session, {
      cwd: join(root, "missing"),
      command: "true",
    });
    await until(() => readJob(dir).finishedAt !== undefined);
    const job = readJob(dir);
    assert.equal(job.state, "failed");
    assert.match(job.error ?? "", /ENOENT/);
  });
});

test(
  "when Pi dies, the worker stops the job and records it as interrupted",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      // A stand-in for Pi that starts one job and is then killed.
      const owner = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { JobRegistry } from ${JSON.stringify(registryUrl)};
        const { dir } = await new JobRegistry().start(process.argv[1], process.argv[2], {
          cwd: process.argv[1],
          command: "echo $$ > shell.pid; sleep 30",
        });
        console.log(dir);
        setInterval(() => {}, 1_000);`,
          root,
          session,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const dir = await new Promise<string>((resolve) =>
        owner.stdout.once("data", (chunk: Buffer) =>
          resolve(chunk.toString().trim()),
        ),
      );
      const pidFile = join(root, "shell.pid");
      await until(
        () => existsSync(pidFile) && readJob(dir).state === "running",
      );
      const shell = Number(readFileSync(pidFile, "utf8"));
      assert.ok(alive(shell));
      owner.kill("SIGKILL");

      await until(() => readJob(dir).state === "interrupted");
      assert.ok(readJob(dir).finishedAt);
      await until(() => !alive(shell));
    });
  },
);

test(
  "a reload hands the registry, with its running jobs, to the next runtime",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      const first = takeOver();
      const dir = await running(first, root, "sleep 30");
      handOver(first);
      const second = takeOver();
      assert.equal(second, first);
      assert.equal(readJob(dir).state, "running");
      // The handover is taken once.
      assert.notEqual(takeOver(), first);
      second.stop(readJob(dir).id);
      assert.equal(
        (await second.waitForEnd(readJob(dir).id, 8_000))?.state,
        "stopped",
      );
    });
  },
);

test("a registry from other code is stopped, not handed over", () => {
  let stopped = false;
  (globalThis as Record<symbol, unknown>)[
    Symbol.for("pi-setup/background-work/job-registry")
  ] = { version: 0, registry: { stopAll: () => (stopped = true) } };
  const registry = takeOver();
  assert.equal(stopped, true);
  assert.ok(registry instanceof JobRegistry);
});

test(
  "a job that ends during a handover reaches the next end listener once",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      const registry = new JobRegistry();
      const dir = await running(
        registry,
        root,
        "while [ ! -e go ]; do sleep 0.05; done",
      );
      handOver(registry);
      writeFileSync(join(root, "go"), "");
      await until(() => readJob(dir).finishedAt !== undefined);
      assert.equal(takeOver(), registry);
      const ends: string[] = [];
      registry.onEnd((job) => ends.push(job.state));
      registry.onEnd((job) => ends.push(`again ${job.state}`));
      assert.deepEqual(ends, ["exited"]);
    });
  },
);

test(
  "without a handover, an end with no listener is not held",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      const registry = new JobRegistry();
      const { dir } = await registry.start(root, session, {
        cwd: root,
        command: "exit 0",
      });
      await until(() => readJob(dir).finishedAt !== undefined);
      const ends: string[] = [];
      registry.onEnd((job) => ends.push(job.state));
      assert.deepEqual(ends, []);
    });
  },
);

test(
  "SIGTERM to the worker ends the job, which Pi records",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      const registry = new JobRegistry();
      const dir = await running(registry, root, "sleep 30");
      const { id, workerPid } = readJob(dir);
      assert.ok(workerPid);
      process.kill(workerPid, "SIGTERM");
      const job = await registry.waitForEnd(id, 8_000);
      // Pi did not ask for this stop, so the job counts as killed from outside.
      assert.equal(job?.state, "exited");
      assert.equal(job?.signal, "SIGTERM");
      assert.equal(readJob(dir).state, "exited");
    });
  },
);

test(
  "at a system shutdown, the worker records the end that Pi cannot",
  options,
  async () => {
    await withTempDir("pi-bg-registry-", async (root) => {
      const owner = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `import { JobRegistry } from ${JSON.stringify(registryUrl)};
        const { dir } = await new JobRegistry().start(process.argv[1], process.argv[2], {
          cwd: process.argv[1],
          command: "sleep 30",
        });
        console.log(dir);
        setInterval(() => {}, 1_000);`,
          root,
          session,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const dir = await new Promise<string>((resolve) =>
        owner.stdout.once("data", (chunk: Buffer) =>
          resolve(chunk.toString().trim()),
        ),
      );
      await until(() => readJob(dir).state === "running");
      const worker = readJob(dir).workerPid as number;
      // Pi cannot react, and the worker gets SIGTERM and exits.
      owner.kill("SIGSTOP");
      process.kill(worker, "SIGTERM");
      await until(() => readJob(dir).finishedAt !== undefined);
      owner.kill("SIGKILL");
      assert.equal(readJob(dir).state, "interrupted");
      // Until Pi is gone, the exited worker stays a zombie.
      await until(() => !alive(worker));
    });
  },
);
