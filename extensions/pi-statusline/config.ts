/** Loads and updates the statusline's optional local configuration and supplies its defaults. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/is-record.ts";

export type StatuslineConfig = {
  opencodeGo?: {
    workspaceId?: string;
  };
  quotas: {
    codex: boolean;
    opencodeGo: boolean;
  };
};

export const DEFAULT_CONFIG: StatuslineConfig = {
  quotas: {
    codex: true,
    opencodeGo: true,
  },
};

// Keep extension state alongside Pi's configured agent directory when one is supplied.
const AGENT_DIR = getAgentDir();
export const CONFIG_PATH = join(AGENT_DIR, "pi-statusline.json");
export const AUTH_PATH = join(AGENT_DIR, "pi-statusline.auth.json");

export async function loadConfig(
  path = CONFIG_PATH,
): Promise<StatuslineConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    // A missing config is an intentional, zero-setup state; other failures matter.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return DEFAULT_CONFIG;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${message}`);
  }
  return parseConfig(raw, path);
}

// Preserve defaults when a config only overrides selected nested quota settings.
function parseConfig(raw: unknown, source: string): StatuslineConfig {
  if (!isRecord(raw)) throw new Error(`${source}: config must be an object`);
  const quotas = raw.quotas ?? {};
  if (!isRecord(quotas)) throw new Error(`${source}: quotas must be an object`);
  for (const key of ["codex", "opencodeGo"] as const) {
    if (quotas[key] !== undefined && typeof quotas[key] !== "boolean")
      throw new Error(`${source}: quotas.${key} must be true or false`);
  }
  const opencodeGo = raw.opencodeGo;
  if (opencodeGo !== undefined) {
    if (!isRecord(opencodeGo))
      throw new Error(`${source}: opencodeGo must be an object`);
    if (
      opencodeGo.workspaceId !== undefined &&
      typeof opencodeGo.workspaceId !== "string"
    )
      throw new Error(`${source}: opencodeGo.workspaceId must be a string`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    quotas: { ...DEFAULT_CONFIG.quotas, ...quotas },
  } as StatuslineConfig;
}

// Strip empty opencodeGo blocks so a cleared workspaceId does not leave a stale
// `opencodeGo: {}` behind in the persisted file.
function compactConfig(config: StatuslineConfig): StatuslineConfig {
  const opencodeGo =
    config.opencodeGo && Object.keys(config.opencodeGo).length > 0
      ? config.opencodeGo
      : undefined;
  return { ...config, opencodeGo };
}

// Persist via temp-file + rename so an interrupted write never leaves a half-written config.
export async function saveConfig(
  config: StatuslineConfig,
  path = CONFIG_PATH,
): Promise<void> {
  const compacted = compactConfig(config);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(compacted, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
