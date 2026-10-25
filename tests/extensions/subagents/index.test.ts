import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  assertAgentName,
  assertSupportedTools,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  parseSubagentConfig,
  planRun,
  selectSubagentModel,
  subagentArguments,
  subagentToolSelectionArgs,
} from "../../../extensions/subagents/index.ts";
import { withTempDir } from "../../helpers.ts";

test("accepts inherited and preferred subagent models", () => {
  assert.deepEqual(
    parseSubagentConfig({
      maxConcurrency: 3,
      maxParallelTasks: 6,
      agents: {
        scout: {},
        worker: {
          models: [
            "openai-codex/gpt-5.6-luna",
            "opencode-go/deepseek-v4-flash",
          ],
        },
      },
    }),
    {
      maxConcurrency: 3,
      maxParallelTasks: 6,
      sessionRetentionDays: 90,
      agents: {
        scout: { models: [] },
        worker: {
          models: [
            "openai-codex/gpt-5.6-luna",
            "opencode-go/deepseek-v4-flash",
          ],
        },
      },
    },
  );
});

test("rejects the raw bash tool in agent definitions", () => {
  assert.deepEqual(assertSupportedTools("worker.md", ["read", "safe_bash"]), [
    "read",
    "safe_bash",
  ]);
  assert.throws(
    () => assertSupportedTools("worker.md", ["read", "bash"]),
    /worker\.md: unsupported subagent tool bash/,
  );
});

test("a custom tool whose sibling extension is missing fails at load", () => {
  assert.throws(
    () => assertSupportedTools("researcher.md", ["web_search"], () => false),
    /researcher\.md: tool web_search needs extensions\/web-search\/index\.ts, which is missing/,
  );
  assert.deepEqual(
    assertSupportedTools("scout.md", ["read", "grep"], () => false),
    ["read", "grep"],
  );
});

test("the subagent config lives in the agent directory, not the package", () => {
  assert.equal(CONFIG_PATH, join(getAgentDir(), "subagents.json"));
  assert.equal(
    relative(resolve("extensions"), CONFIG_PATH).startsWith(".."),
    true,
  );
});

test("fills omitted subagent config fields with defaults", () => {
  assert.deepEqual(parseSubagentConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(
    parseSubagentConfig({ agents: { worker: { models: ["a/b"] } } }),
    {
      maxConcurrency: DEFAULT_CONFIG.maxConcurrency,
      maxParallelTasks: DEFAULT_CONFIG.maxParallelTasks,
      sessionRetentionDays: 90,
      agents: { worker: { models: ["a/b"] } },
    },
  );
  assert.throws(() => parseSubagentConfig([]), /expected a JSON object/);
  assert.throws(
    () => parseSubagentConfig({ agents: [] }),
    /agents must be an object/,
  );
});

test("rejects invalid subagent limits", () => {
  assert.throws(
    () =>
      parseSubagentConfig({
        maxConcurrency: 0,
        maxParallelTasks: 4,
        agents: {},
      }),
    /maxConcurrency must be a positive integer/,
  );
  assert.throws(
    () => parseSubagentConfig({ sessionRetentionDays: 1.5 }),
    /sessionRetentionDays must be a positive integer/,
  );
});

test("rejects the obsolete single-model configuration", () => {
  assert.throws(
    () =>
      parseSubagentConfig({
        maxConcurrency: 2,
        maxParallelTasks: 4,
        agents: { worker: { model: "openai-codex/gpt-5.6-luna" } },
      }),
    /model is unsupported; use models/,
  );
});

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

test("agent names must be usable inside session ids", () => {
  assert.equal(assertAgentName("scout.md", "code_review-2"), "code_review-2");
  assert.throws(
    () => assertAgentName("scout.md", "my scout"),
    /scout\.md: agent name my scout may contain only/,
  );
  assert.throws(() => assertAgentName("x.md", "-scout"), /must start/);
});

const AGENTS = [
  {
    name: "scout",
    description: "recon",
    tools: ["read"],
    modelPreferences: [],
    systemPrompt: "",
  },
  {
    name: "worker",
    description: "edits",
    tools: ["read"],
    modelPreferences: [],
    systemPrompt: "",
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
