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
    name: "analyst",
    description: "independent analysis",
    tools: ["read"],
    modelPreferences: [],
    systemPrompt: "",
    source: "package",
  },
];

test("built-in agents include the read-only analyst instead of worker", () => {
  const agents = readAgentDir(
    join(import.meta.dirname, "../../../extensions/subagents/agents"),
    "package",
    parseSubagentConfig({}),
  );
  assert.deepEqual(agents.map((agent) => agent.name).sort(), [
    "analyst",
    "researcher",
    "scout",
  ]);
  const analyst = agents.find((agent) => agent.name === "analyst")!;
  const scout = agents.find((agent) => agent.name === "scout")!;
  const researcher = agents.find((agent) => agent.name === "researcher")!;
  assert.equal(analyst.source, "package");
  assert.match(analyst.description, /General-purpose independent analysis/);
  assert.deepEqual(analyst.tools, ["read", "grep", "find", "ls", "ask_parent"]);
  assert.deepEqual(analyst.tools, scout.tools);
  assert.deepEqual(researcher.tools, ["web_search", "web_fetch", "ask_parent"]);
  assert.equal(
    analyst.systemPrompt.trim(),
    `You independently investigate questions and assess proposed solutions.
You start with a fresh context and receive your task from the parent assistant.

Work independently:
- Read the relevant material and applicable project instructions.
- Check claims against the available evidence.
- Treat the parent's conclusions as hypotheses, not facts.
- Consider alternatives when they materially affect the answer.
- Ask the parent when missing information prevents a useful answer.

Stay read-only:
- Do not create, edit, or delete files.
- Do not install dependencies or change project state.
- Report proposed changes rather than applying them.

Focus on the assigned question:
- Look for meaningful problems, not reasons to produce findings.
- Distinguish verified facts from assumptions and judgments.
- State when the evidence does not support a conclusion.
- If you find no meaningful problems, say so.

Return:
- A direct answer or overall assessment.
- The evidence and reasoning that support it.
- For each problem, its consequence and the conditions that trigger it.
- Important uncertainties or limits of your investigation.

For claims about code, cite file paths and line references.
Keep the response proportional to the task.
Include excerpts or background only when they help explain the answer.`,
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
        ["analyst", "package"],
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
