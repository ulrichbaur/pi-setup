import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, type SubagentConfig } from "./config.ts";
import { AGENT_NAME_PATTERN } from "./sessions.ts";
import type { AgentDefinition } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(EXTENSION_DIR, "..", "..");
const AGENTS_DIR = join(EXTENSION_DIR, "agents");
const AGENT_NAMES = ["scout", "researcher", "analyst"];
const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  web_fetch: join(EXTENSION_DIR, "..", "web-fetch", "index.ts"),
  web_search: join(EXTENSION_DIR, "..", "web-search", "index.ts"),
  ask_parent: join(EXTENSION_DIR, "tools", "ask-parent.ts"),
};

function parseTools(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/**
 * Rejects unknown tools and custom tools whose sibling extension is missing,
 * so a broken dependency fails when the extension loads rather than inside a
 * child process.
 */
export function assertSupportedTools(
  fileName: string,
  tools: string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  for (const tool of tools) {
    const extensionPath = CUSTOM_TOOL_EXTENSIONS[tool];
    if (!BUILTIN_TOOLS.has(tool) && !extensionPath) {
      throw new Error(`${fileName}: unsupported subagent tool ${tool}`);
    }
    if (extensionPath && !exists(extensionPath)) {
      const shown = relative(PACKAGE_DIR, extensionPath);
      throw new Error(
        `${fileName}: tool ${tool} needs ${shown}, which is missing`,
      );
    }
  }
  return tools;
}

/** Agent names become part of session ids, so they use a restricted set. */
export function assertAgentName(fileName: string, name: string): string {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `${fileName}: agent name ${name} may contain only letters, digits, _, and -, and must start with a letter or digit`,
    );
  }
  return name;
}

export function loadAgents(config: SubagentConfig): AgentDefinition[] {
  const agents = AGENT_NAMES.map((name): AgentDefinition => {
    const file = join(AGENTS_DIR, `${name}.md`);
    const label = file;
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
      readFileSync(file, "utf8"),
    );
    if (
      typeof frontmatter.name !== "string" ||
      typeof frontmatter.description !== "string"
    ) {
      throw new Error(`${label}: an agent needs a name and a description`);
    }
    return {
      name: assertAgentName(label, frontmatter.name),
      description: frontmatter.description,
      tools: assertSupportedTools(label, parseTools(frontmatter.tools)),
      modelPreferences: config.agents[frontmatter.name]?.models ?? [],
      systemPrompt: body,
    };
  });

  const loadedNames = new Set(agents.map((agent) => agent.name));
  for (const name of Object.keys(config.agents)) {
    if (!loadedNames.has(name)) {
      throw new Error(
        `${CONFIG_PATH}: agents.${name} is not a built-in agent. Supported agents: ${AGENT_NAMES.join(", ")}. Replace agents.worker with agents.analyst; custom agents are no longer supported`,
      );
    }
  }
  return agents;
}

export function findAgent(
  agents: AgentDefinition[],
  name: string,
): AgentDefinition {
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent) {
    throw new Error(
      `Unknown agent ${name}. Available agents: ${agents.map((candidate) => candidate.name).join(", ")}`,
    );
  }
  return agent;
}
