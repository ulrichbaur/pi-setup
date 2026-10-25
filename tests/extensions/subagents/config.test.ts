import assert from "node:assert/strict";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  parseSubagentConfig,
} from "../../../extensions/subagents/config.ts";

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
      backgroundQuestionTimeoutMinutes: 10,
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
      backgroundQuestionTimeoutMinutes: 10,
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
