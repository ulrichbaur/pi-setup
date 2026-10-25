import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/is-record.ts";

// Config is machine-local state, so it lives with Pi's other agent files.
export const CONFIG_PATH = join(getAgentDir(), "subagents.json");

interface AgentModelConfig {
  models: string[];
}

export interface SubagentConfig {
  maxConcurrency: number;
  maxParallelTasks: number;
  sessionRetentionDays: number;
  backgroundApprovalTimeoutMinutes: number;
  agents: Record<string, AgentModelConfig>;
}

export const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrency: 4,
  maxParallelTasks: 8,
  sessionRetentionDays: 90,
  backgroundApprovalTimeoutMinutes: 10,
  agents: {},
};

function positiveInteger(
  value: unknown,
  field: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${CONFIG_PATH}: ${field} must be a positive integer`);
  }
  return value as number;
}

/** Validates an optional config; omitted fields take the built-in defaults. */
export function parseSubagentConfig(value: unknown): SubagentConfig {
  if (!isRecord(value)) {
    throw new Error(`${CONFIG_PATH}: expected a JSON object`);
  }
  const agentValues = value.agents ?? {};
  if (!isRecord(agentValues)) {
    throw new Error(`${CONFIG_PATH}: agents must be an object`);
  }

  const agents: Record<string, AgentModelConfig> = {};
  for (const [name, agentValue] of Object.entries(agentValues)) {
    if (!isRecord(agentValue)) {
      throw new Error(`${CONFIG_PATH}: agents.${name} must be an object`);
    }
    if (agentValue.model !== undefined) {
      throw new Error(
        `${CONFIG_PATH}: agents.${name}.model is unsupported; use models`,
      );
    }
    const configuredModels = agentValue.models ?? [];
    if (
      !Array.isArray(configuredModels) ||
      configuredModels.some(
        (model) => typeof model !== "string" || !model.trim(),
      )
    ) {
      throw new Error(
        `${CONFIG_PATH}: agents.${name}.models must contain model ids`,
      );
    }
    agents[name] = {
      models: configuredModels.map((model) => (model as string).trim()),
    };
  }

  return {
    maxConcurrency: positiveInteger(
      value.maxConcurrency,
      "maxConcurrency",
      DEFAULT_CONFIG.maxConcurrency,
    ),
    maxParallelTasks: positiveInteger(
      value.maxParallelTasks,
      "maxParallelTasks",
      DEFAULT_CONFIG.maxParallelTasks,
    ),
    sessionRetentionDays: positiveInteger(
      value.sessionRetentionDays,
      "sessionRetentionDays",
      DEFAULT_CONFIG.sessionRetentionDays,
    ),
    backgroundApprovalTimeoutMinutes: positiveInteger(
      value.backgroundApprovalTimeoutMinutes,
      "backgroundApprovalTimeoutMinutes",
      DEFAULT_CONFIG.backgroundApprovalTimeoutMinutes,
    ),
    agents,
  };
}

export function loadConfig(): SubagentConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    return parseSubagentConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${CONFIG_PATH}: invalid JSON`, { cause: error });
    }
    throw error;
  }
}
