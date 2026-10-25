import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyEvent,
  finalStatus,
  planRun,
  selectSubagentModel,
  subagentArguments,
  subagentToolSelectionArgs,
} from "../../../extensions/subagents/run.ts";
import { withTempDir } from "../../helpers.ts";

test("selects the first available preferred model then the parent", () => {
  const preferences = [
    "openai-codex/gpt-5.6-luna",
    "opencode-go/deepseek-v4-flash",
  ];
  assert.equal(
    selectSubagentModel(
      preferences,
      new Set(["openai-codex/gpt-5.6-luna", "opencode-go/deepseek-v4-flash"]),
      "anthropic/claude-sonnet",
    ),
    "openai-codex/gpt-5.6-luna",
  );
  assert.equal(
    selectSubagentModel(
      preferences,
      new Set(["opencode-go/deepseek-v4-flash"]),
      "anthropic/claude-sonnet",
    ),
    "opencode-go/deepseek-v4-flash",
  );
  assert.equal(
    selectSubagentModel(preferences, new Set(), "anthropic/claude-sonnet"),
    "anthropic/claude-sonnet",
  );
});

test("selects custom tools for child Pi processes", () => {
  assert.deepEqual(
    subagentToolSelectionArgs(["read", "web_search", "web_fetch"]),
    ["--tools", "read,web_search,web_fetch"],
  );
  assert.deepEqual(subagentToolSelectionArgs([]), ["--no-tools"]);
});

test("child Pi processes run in RPC mode with the agent's settings", () => {
  const args = subagentArguments(
    ["read", "web_search"],
    "/tmp/scout.md",
    "openai/gpt-5",
    "high",
    ["--session-dir", "/sessions", "--session-id", "scout-1a2b3c4d"],
    false,
  );
  assert.deepEqual(args.slice(0, 8), [
    "--mode",
    "rpc",
    "--session-dir",
    "/sessions",
    "--session-id",
    "scout-1a2b3c4d",
    "--no-skills",
    "--no-extensions",
  ]);
  assert.ok(!args.includes("-p"));
  assert.deepEqual(args.slice(-6), [
    "--model",
    "openai/gpt-5",
    "--thinking",
    "high",
    "--append-system-prompt",
    "/tmp/scout.md",
  ]);
  assert.ok(args.some((arg) => arg.endsWith(join("web-search", "index.ts"))));
  assert.ok(
    !subagentArguments([], "/tmp/x.md", undefined, "off", [], false).includes(
      "--thinking",
    ),
  );
});

test("safe_bash asks the user only when one can answer", () => {
  const args = (tools: string[], userAvailable: boolean) =>
    subagentArguments(tools, "/p.md", undefined, undefined, [], userAvailable);
  assert.ok(args(["safe_bash"], true).includes("--safe-bash-ask"));
  assert.ok(!args(["safe_bash"], false).includes("--safe-bash-ask"));
  assert.ok(!args(["read", "ask_user"], true).includes("--safe-bash-ask"));
});

const AGENTS = [
  {
    name: "scout",
    description: "recon",
    tools: ["read"],
    modelPreferences: [],
    systemPrompt: "",
    source: "package" as const,
  },
  {
    name: "worker",
    description: "edits",
    tools: ["read"],
    modelPreferences: [],
    systemPrompt: "",
    source: "package" as const,
  },
];

test("a new run gets a fresh session named after its task", () => {
  const plan = planRun(
    { agent: "scout", task: "Map the\n  auth module" },
    AGENTS,
    "/repo",
    "/sessions",
  );
  assert.equal(plan.agent.name, "scout");
  assert.equal(plan.cwd, "/repo");
  assert.equal(plan.target.kind, "new");
  assert.match(plan.target.id, /^scout-[0-9a-f]{8}$/);
  assert.equal(
    plan.target.kind === "new" && plan.target.name,
    "scout: Map the auth module",
  );
  assert.throws(
    () => planRun({ task: "x" }, AGENTS, "/repo", "/sessions"),
    /Provide an agent or a session/,
  );
});

test("a resumed run keeps its agent and working directory", async () => {
  await withTempDir("subagent-sessions-", (directory) => {
    const path = join(
      directory,
      "2026-10-25T10-00-00-000Z_worker-0a1b2c3d.jsonl",
    );
    writeFileSync(
      path,
      `${JSON.stringify({ type: "session", id: "worker-0a1b2c3d", cwd: "/elsewhere" })}\n`,
    );
    const plan = planRun(
      { session: "worker-0a1b2c3d", task: "Also add tests" },
      AGENTS,
      "/repo",
      directory,
    );
    assert.equal(plan.agent.name, "worker");
    assert.equal(plan.cwd, "/elsewhere");
    assert.deepEqual(plan.target, {
      kind: "resume",
      id: "worker-0a1b2c3d",
      path,
    });

    const resume = (request: object) =>
      planRun({ task: "x", ...request }, AGENTS, "/repo", directory);
    assert.throws(
      () => resume({ session: "worker-0a1b2c3d", agent: "scout" }),
      /belongs to worker, not scout/,
    );
    assert.throws(
      () => resume({ session: "worker-0a1b2c3d", cwd: "/repo" }),
      /cwd cannot be combined with session/,
    );
    assert.throws(
      () => resume({ session: "worker-ffffffff" }),
      /Unknown subagent session worker-ffffffff/,
    );
    assert.throws(
      () => resume({ session: "../worker" }),
      /Malformed subagent session id/,
    );

    writeFileSync(path, "not json\n");
    assert.throws(() => resume({ session: "worker-0a1b2c3d" }), {
      message: `${path}: session header is not valid JSON`,
    });
  });
});

test("progress tracks tools that run at the same time", () => {
  const result: Parameters<typeof applyEvent>[0] = {
    agent: "scout",
    task: "t",
    output: "",
    exitCode: -1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    progress: {
      status: "running",
      recentTools: [],
      toolCount: 0,
      durationMs: 0,
      lastMessage: "",
    },
  };
  const start = (id: string, toolName: string, path: string) =>
    applyEvent(result, {
      type: "tool_execution_start",
      toolCallId: id,
      toolName,
      args: { path },
    });
  const end = (id: string) =>
    applyEvent(result, { type: "tool_execution_end", toolCallId: id });

  start("a", "ls", "lib");
  start("b", "read", "lib/x.ts");
  assert.equal(result.progress.currentTool, "read");
  end("a");
  assert.equal(result.progress.currentTool, "read");
  end("b");
  assert.equal(result.progress.currentTool, undefined);
  assert.deepEqual(result.progress.recentTools, [
    { tool: "ls", args: "lib" },
    { tool: "read", args: "lib/x.ts" },
  ]);
  assert.equal(result.progress.toolCount, 2);
});

test("a successful retry clears the failed turn's error", () => {
  const result: Parameters<typeof applyEvent>[0] = {
    agent: "scout",
    task: "t",
    output: "",
    exitCode: -1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    progress: {
      status: "running",
      recentTools: [],
      toolCount: 0,
      durationMs: 0,
      lastMessage: "",
    },
  };
  const turn = (message: Record<string, unknown>) =>
    applyEvent(result, {
      type: "message_end",
      message: { role: "assistant", content: "", ...message },
    });

  turn({ stopReason: "error", errorMessage: "fetch failed" });
  assert.equal(result.progress.error, "fetch failed");
  turn({ stopReason: "stop", content: "Done." });
  assert.equal(result.progress.error, undefined);
  assert.equal(result.output, "Done.");

  turn({ stopReason: "aborted" });
  assert.equal(result.progress.error, "Agent stopped: aborted");
  applyEvent(result, {
    type: "auto_retry_end",
    success: false,
    finalError: "529 overloaded",
  });
  assert.equal(result.progress.error, "529 overloaded");
});

test("a settled run survives a forced stop; other failures do not", () => {
  assert.equal(finalStatus(0, true, false, undefined), "completed");
  assert.equal(finalStatus(1, true, true, undefined), "completed");
  assert.equal(finalStatus(1, false, true, undefined), "failed");
  assert.equal(finalStatus(1, true, false, undefined), "failed");
  assert.equal(finalStatus(0, true, false, "fetch failed"), "failed");
});
