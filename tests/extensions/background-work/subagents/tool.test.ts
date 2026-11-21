import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { withTempDir } from "../../../helpers.ts";
import { startFakeModel, text } from "../../../tui/fake-model.ts";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../../..");
const piCli = join(
  repo,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const extension = join(repo, "extensions/background-work/index.ts");
const PROMPT = "Delegate the listing";

test("print mode waits for a real subagent and hands its result to the parent", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async () => {
  await withTempDir("pi-subagent-print-", async (root) => {
    const agentDir = join(root, "agent");
    const sessions = join(root, "sessions");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(sessions), mkdir(cwd)]);
    await writeFile(join(cwd, "notes.txt"), "a file to list\n");

    const { server, port } = await startFakeModel((messages) => {
      const system = text(messages.find((m) => m.role === "system")?.content);
      const last = messages.at(-1);
      const lastText = text(last?.content);
      // The child is a real second Pi process with the scout's prompt.
      if (system.includes("You are a scout")) {
        return last?.role === "tool"
          ? { text: "Scout found the files" }
          : { tool: "ls", args: { path: "." } };
      }
      if (last?.role === "user" && lastText === PROMPT) {
        return {
          tool: "subagent",
          args: { agent: "scout", task: "TASK list" },
        };
      }
      if (last?.role === "tool" && lastText.includes("Scout found the files"))
        return { text: "Parent got: Scout found the files" };
      if (lastText.includes("Started in the background"))
        return { text: "Parent was not given the result" };
      return { text: "Unexpected request" };
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
          PROMPT,
        ],
        {
          cwd,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_SKIP_VERSION_CHECK: "1",
          },
          timeout: 25_000,
        },
      );
      run.child.stdin?.end();
      const { stdout } = await run;
      assert.match(stdout, /Parent got: Scout found the files/);

      // The parent's saved tool result holds the finished run itself.
      const [file] = await readdir(sessions);
      const entries = (await readFile(join(sessions, file), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const toolResult = entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "subagent",
      )?.message;
      assert.ok(toolResult, "no subagent tool result was saved");
      assert.equal(toolResult.details.background, undefined);
      const [result] = toolResult.details.results;
      assert.equal(result.runId, undefined);
      assert.equal(result.progress.status, "completed");

      // The child saved its own session.
      const childSessions = await readdir(
        join(agentDir, "subagents", "sessions"),
      );
      assert.ok(
        childSessions.some((name) =>
          name.endsWith(`_${result.sessionId}.jsonl`),
        ),
        `no session file for ${result.sessionId}: ${childSessions.join(", ")}`,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
