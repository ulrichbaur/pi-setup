import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertAgentName,
  assertSupportedTools,
  loadAgents,
} from "../../../extensions/subagents/agents.ts";
import { parseSubagentConfig } from "../../../extensions/subagents/config.ts";

test("only the built-in read-only agents load with configured models", () => {
  const agents = loadAgents(
    parseSubagentConfig({
      agents: { analyst: { models: ["provider/model"] } },
    }),
  );
  assert.deepEqual(agents.map((agent) => agent.name).sort(), [
    "analyst",
    "researcher",
    "scout",
  ]);
  const analyst = agents.find((agent) => agent.name === "analyst")!;
  const scout = agents.find((agent) => agent.name === "scout")!;
  const researcher = agents.find((agent) => agent.name === "researcher")!;
  assert.match(analyst.description, /General-purpose independent analysis/);
  assert.deepEqual(analyst.tools, ["read", "grep", "find", "ls", "ask_parent"]);
  assert.deepEqual(analyst.tools, scout.tools);
  assert.deepEqual(researcher.tools, ["web_search", "web_fetch", "ask_parent"]);
  assert.deepEqual(analyst.modelPreferences, ["provider/model"]);
  assert.deepEqual(scout.modelPreferences, []);
  assert.match(analyst.systemPrompt, /Stay read-only:/);
});

test("editing, shell, and unsupported tools fail at load with a path", () => {
  for (const tool of ["write", "edit", "bash", "safe_bash", "unknown"]) {
    assert.throws(
      () => assertSupportedTools("/agents/scout.md", ["read", tool]),
      { message: `/agents/scout.md: unsupported subagent tool ${tool}` },
    );
  }
});

test("a tool whose sibling extension is missing fails at load", () => {
  assert.throws(
    () => assertSupportedTools("researcher.md", ["web_search"], () => false),
    /researcher\.md: tool web_search needs extensions\/web-search\/index\.ts, which is missing/,
  );
  assert.deepEqual(
    assertSupportedTools("scout.md", ["read", "grep"], () => false),
    ["read", "grep"],
  );
});

test("unknown agent config names fail clearly instead of being ignored", () => {
  for (const name of ["worker", "custom"]) {
    assert.throws(
      () =>
        loadAgents(parseSubagentConfig({ agents: { [name]: { models: [] } } })),
      new RegExp(`subagents\\.json: agents\\.${name} is not a built-in agent`),
    );
  }
});

test("agent names must be usable inside session ids", () => {
  assert.equal(assertAgentName("scout.md", "code_review-2"), "code_review-2");
  assert.throws(
    () => assertAgentName("scout.md", "my scout"),
    /scout\.md: agent name my scout may contain only/,
  );
  assert.throws(() => assertAgentName("x.md", "-scout"), /must start/);
});
