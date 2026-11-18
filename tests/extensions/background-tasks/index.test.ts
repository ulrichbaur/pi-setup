import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  DEFAULT_TIMEOUT_MS,
  inspectJob,
  jobDir,
} from "../../../extensions/background-tasks/runner.ts";
import { withTempDir } from "../../helpers.ts";
import { startFakeModel, text } from "../../tui/fake-model.ts";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const piCli = join(
  repo,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const extension = join(repo, "extensions/background-tasks/index.ts");

test("Pi submits a job, closes before it finishes, and recovers its log on resume", {
  skip: process.platform === "win32",
  timeout: 20_000,
}, async () => {
  await withTempDir("pi-background-tool-", async (root) => {
    const agentDir = join(root, "agent");
    const sessions = join(root, "sessions");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(sessions), mkdir(cwd)]);

    const prompt = "Start the test job";
    const resumePrompt = "Read the background job log";
    let logPath: string | undefined;
    const { server, port } = await startFakeModel((messages) => {
      const last = messages.at(-1);
      if (last?.role === "user" && text(last.content) === prompt) {
        return {
          tool: "task_start",
          args: {
            command:
              "while [ ! -e proceed ]; do sleep 0.05; done; printf 'job output\\n'; exit 7",
            label: "Test job",
          },
        };
      }
      if (
        last?.role === "tool" &&
        text(last.content).includes("Submitted background job")
      ) {
        logPath = text(last.content).match(/^Output log: (.+)$/m)?.[1];
        return { text: "Job submitted" };
      }
      if (last?.role === "user" && text(last.content) === resumePrompt) {
        const originalResult = messages.find(
          (message) =>
            message.role === "tool" &&
            text(message.content).includes("Submitted background job"),
        );
        const path = text(originalResult?.content).match(
          /^Output log: (.+)$/m,
        )?.[1];
        return path
          ? { tool: "read", args: { path } }
          : { text: "No job in this session" };
      }
      return {
        text: last?.role === "tool" ? text(last.content) : "Unexpected request",
      };
    });

    try {
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fake: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              api: "openai-completions",
              apiKey: "fake",
              models: [{ id: "fake-model", contextWindow: 100_000 }],
            },
          },
        }),
      );
      const runPi = (...args: string[]) => {
        const run = exec(
          process.execPath,
          [
            piCli,
            "--print",
            "--provider",
            "fake",
            "--model",
            "fake-model",
            "--no-skills",
            "--no-extensions",
            "--extension",
            extension,
            "--session-dir",
            sessions,
            ...args,
          ],
          {
            cwd,
            env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
            timeout: 7_000,
          },
        );
        run.child.stdin?.end();
        return run;
      };
      try {
        const initial = await runPi(prompt);
        assert.match(initial.stdout, /Job submitted/);
      } finally {
        // The command cannot finish until after the launching Pi has exited.
        await writeFile(join(cwd, "proceed"), "");
      }
      assert.ok(logPath, "Pi did not return a log path");
      const files = await readdir(sessions);
      assert.equal(files.length, 1);
      const sessionFile = join(sessions, files[0]);
      const { id: sessionId } = JSON.parse(
        (await readFile(sessionFile, "utf8")).split("\n")[0],
      );
      const dir = dirname(logPath);
      const { job: initialJob } = await inspectJob(dir);
      assert.equal(
        dir,
        jobDir(join(agentDir, "background-tasks"), sessionId, initialJob.id),
      );
      assert.equal(initialJob.cwd, cwd);
      assert.equal(initialJob.timeoutMs, DEFAULT_TIMEOUT_MS);
      assert.equal(initialJob.label, "Test job");
      const deadline = Date.now() + 3_000;
      let job = initialJob;
      while (!job.finishedAt && Date.now() < deadline) {
        await delay(25);
        ({ job } = await inspectJob(dir));
      }
      assert.equal(job.state, "exited");
      assert.equal(job.exitCode, 7);
      const resumed = await runPi("--session", sessionFile, resumePrompt);
      assert.match(resumed.stdout, /job output/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
