import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertAgentName,
  assertSupportedTools,
  mergeAgents,
  readAgentDir,
} from "../../../extensions/subagents/agents.ts";
import { parseSubagentConfig } from "../../../extensions/subagents/config.ts";
import type { AgentDefinition } from "../../../extensions/subagents/types.ts";
import { withTempDir } from "../../helpers.ts";

const AGENTS: AgentDefinition[] = [
  {
    name: "scout",
    description: "recon",
    tools: ["read"],
    modelPreferences: [],
    systemPrompt: "",
    source: "package",
  },
  {
    name: "worker",
    description: "edits",
    tools: ["read"],
    modelPreferences: [],
    systemPrompt: "",
    source: "package",
  },
];

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

test("agent names must be usable inside session ids", () => {
  assert.equal(assertAgentName("scout.md", "code_review-2"), "code_review-2");
  assert.throws(
    () => assertAgentName("scout.md", "my scout"),
    /scout\.md: agent name my scout may contain only/,
  );
  assert.throws(() => assertAgentName("x.md", "-scout"), /must start/);
});

test("agent folders load with their source; later ones override", async () => {
  await withTempDir("subagent-agents-", (directory) => {
    const config = parseSubagentConfig({});
    const write = (name: string, text: string) =>
      writeFileSync(join(directory, name), text);
    write(
      "scout.md",
      "---\nname: scout\ndescription: project scout\ntools: read\n---\nLook closely.",
    );
    write("notes.txt", "ignored");
    const project = readAgentDir(directory, "project", config);
    assert.deepEqual(
      project.map(({ name, description, tools, source, systemPrompt }) => ({
        name,
        description,
        tools,
        source,
        systemPrompt: systemPrompt.trim(),
      })),
      [
        {
          name: "scout",
          description: "project scout",
          tools: ["read"],
          source: "project",
          systemPrompt: "Look closely.",
        },
      ],
    );
    assert.deepEqual(
      readAgentDir(join(directory, "missing"), "user", config),
      [],
    );

    const merged = mergeAgents(AGENTS, project);
    assert.deepEqual(
      merged.map((agent) => [agent.name, agent.source]),
      [
        ["scout", "project"],
        ["worker", "package"],
      ],
    );

    write("broken.md", "---\nname: broken\n---\nNo description.");
    assert.throws(() => readAgentDir(directory, "project", config), {
      message: `${join(directory, "broken.md")}: an agent needs a name and a description`,
    });
    write("broken.md", "---\nname: scout\ndescription: twin\n---\n");
    assert.throws(
      () => readAgentDir(directory, "project", config),
      /agent scout is defined twice/,
    );
    write("broken.md", "---\nname: shell\ndescription: x\ntools: bash\n---\n");
    assert.throws(
      () => readAgentDir(directory, "user", config),
      new RegExp(
        `${join(directory, "broken.md").replaceAll(".", "\\.")}: unsupported subagent tool bash`,
      ),
    );
  });
});
