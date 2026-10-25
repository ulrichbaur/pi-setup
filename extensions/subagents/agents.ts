import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, type SubagentConfig } from "./config.ts";
import { AGENT_NAME_PATTERN } from "./sessions.ts";
import type { AgentDefinition, AgentSource } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(EXTENSION_DIR, "..", "..");
const AGENTS_DIR = join(EXTENSION_DIR, "agents");
// Subagents never get the raw bash tool; safe_bash is the only shell.
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
export const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  safe_bash: join(EXTENSION_DIR, "tools", "safe-bash.ts"),
  web_fetch: join(EXTENSION_DIR, "..", "web-fetch", "index.ts"),
  web_search: join(EXTENSION_DIR, "..", "web-search", "index.ts"),
  ask_user: join(EXTENSION_DIR, "tools", "ask-user.ts"),
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

export const USER_AGENTS_DIR = join(getAgentDir(), "agents");

export function projectAgentsDir(cwd: string): string {
  return join(cwd, ".pi", "agents");
}

export function readAgentDir(
  directory: string,
  source: AgentSource,
  config: SubagentConfig,
): AgentDefinition[] {
  const names = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".md"))
    : [];
  const agents = names.map((name): AgentDefinition => {
    const file = join(directory, name);
    const label = source === "package" ? name : file;
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
      source,
    };
  });
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.name)) {
      throw new Error(`${directory}: agent ${agent.name} is defined twice`);
    }
    seen.add(agent.name);
  }
  return agents;
}

/** Later lists override earlier ones by name: package, user, project. */
export function mergeAgents(...lists: AgentDefinition[][]): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of lists.flat()) byName.set(agent.name, agent);
  return [...byName.values()];
}

export function loadAgents(config: SubagentConfig): AgentDefinition[] {
  const agents = mergeAgents(
    readAgentDir(AGENTS_DIR, "package", config),
    readAgentDir(USER_AGENTS_DIR, "user", config),
  );
  if (agents.length === 0) {
    throw new Error(`${AGENTS_DIR}: no valid agent definitions found`);
  }
  const loadedNames = new Set(agents.map((agent) => agent.name));
  for (const name of Object.keys(config.agents)) {
    if (!loadedNames.has(name)) {
      throw new Error(
        `${CONFIG_PATH}: agents.${name} has no matching agent file`,
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
