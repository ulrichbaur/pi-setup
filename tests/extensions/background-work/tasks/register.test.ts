import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTasks } from "../../../../extensions/background-work/tasks/register.ts";
import {
  DEFAULT_TIMEOUT_MS,
  jobDir,
  readJob,
} from "../../../../extensions/background-work/tasks/runner.ts";
import { withTempDir } from "../../../helpers.ts";
import { startFakeModel, text } from "../../../tui/fake-model.ts";
import { until } from "./fake-jobs.ts";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../../..");
const piCli = join(
  repo,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const extension = join(repo, "extensions/background-work/index.ts");

test("a job stops with Pi, ends as interrupted, and keeps its log for a resume", {
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
            command: "echo $$ > job.pid; printf 'job output\\n'; sleep 30",
            label: "Test job",
          },
        };
      }
      if (
        last?.role === "tool" &&
        text(last.content).includes("Submitted background job")
      ) {
        logPath = text(last.content).match(/^Output log: (.+)$/m)?.[1];
        // Pi exits after this reply, so the reply waits until the job runs.
        return (async () => {
          const deadline = Date.now() + 5_000;
          while (!existsSync(join(cwd, "job.pid")) && Date.now() < deadline)
            await delay(25);
          return { text: "Job submitted" };
        })();
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
      const initial = await runPi(prompt);
      assert.match(initial.stdout, /Job submitted/);
      assert.ok(logPath, "Pi did not return a log path");
      const files = await readdir(sessions);
      assert.equal(files.length, 1);
      const sessionFile = join(sessions, files[0]);
      const { id: sessionId } = JSON.parse(
        (await readFile(sessionFile, "utf8")).split("\n")[0],
      );
      const dir = dirname(logPath);
      const initialJob = readJob(dir);
      assert.equal(
        dir,
        jobDir(join(agentDir, "background-tasks"), sessionId, initialJob.id),
      );
      assert.equal(initialJob.cwd, cwd);
      assert.equal(initialJob.timeoutMs, DEFAULT_TIMEOUT_MS);
      assert.equal(initialJob.label, "Test job");
      // Pi has exited, so the job's worker records the end and stops it.
      const shell = Number(await readFile(join(cwd, "job.pid"), "utf8"));
      const deadline = Date.now() + 8_000;
      const alive = () => {
        try {
          process.kill(shell, 0);
          return true;
        } catch {
          return false;
        }
      };
      while (
        (readJob(dir).state !== "interrupted" || alive()) &&
        Date.now() < deadline
      )
        await delay(25);
      assert.equal(readJob(dir).state, "interrupted");
      assert.equal(alive(), false);
      const resumed = await runPi("--session", sessionFile, resumePrompt);
      assert.match(resumed.stdout, /job output/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("a job end during shutdown reaches neither the closed pi nor its ctx", {
  skip: process.platform === "win32",
  timeout: 20_000,
}, async () => {
  await withTempDir("pi-background-close-", async (root) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      let closed = false;
      const stale = () => {
        if (closed) throw new Error("This extension ctx is stale");
      };
      const handlers: Record<string, (event: unknown, ctx?: unknown) => void> =
        {};
      const sent: unknown[] = [];
      const pi = {
        registerTool: () => {},
        on: (
          event: string,
          handler: (event: unknown, ctx?: unknown) => void,
        ) => {
          handlers[event] = handler;
        },
        sendMessage: (message: unknown) => {
          stale();
          sent.push(message);
        },
      } as unknown as ExtensionAPI;
      const { registry, root: jobs } = await registerTasks(pi);
      const sessionId = "00112233-4455-6677-8899-aabbccddeeff";
      handlers.session_start(
        {},
        {
          mode: "tui",
          sessionManager: { getSessionId: () => sessionId },
          ui: { notify: stale, setStatus: () => {} },
        },
      );
      // The notice starts its read; then the session shuts down.
      registry.onEnd(() => {
        handlers.session_shutdown({ reason: "quit" });
        closed = true;
      });
      const { dir } = await registry.start(jobs(), sessionId, {
        cwd: root,
        command: "exit 0",
      });
      await until(() => readJob(dir).finishedAt !== undefined);
      await delay(200);
      assert.deepEqual(sent, []);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
