import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSupportedTools,
  DEFAULT_CONFIG,
  parseSubagentConfig,
  selectSubagentModel,
  subagentToolSelectionArgs,
} from "../extensions/subagents/index.ts";
import { dangerousCommandReason } from "../extensions/subagents/tools/safe-bash.ts";

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

test("fills omitted subagent config fields with defaults", () => {
  assert.deepEqual(parseSubagentConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(
    parseSubagentConfig({ agents: { worker: { models: ["a/b"] } } }),
    {
      maxConcurrency: DEFAULT_CONFIG.maxConcurrency,
      maxParallelTasks: DEFAULT_CONFIG.maxParallelTasks,
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

test("safe bash blocks destructive system commands", () => {
  assert.match(dangerousCommandReason("sudo reboot") ?? "", /blocked/);
  assert.match(dangerousCommandReason("rm -rf /") ?? "", /blocked/);
  assert.equal(dangerousCommandReason("pnpm test"), null);
});
