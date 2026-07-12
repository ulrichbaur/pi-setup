/** Loads and updates the statusline's optional local configuration and supplies its defaults. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const CONFIG_PATH = join(AGENT_DIR, "pi-statusline.json");
export const AUTH_PATH = join(AGENT_DIR, "pi-statusline.auth.json");

// Preserve defaults when a config only overrides selected nested quota settings.
export async function loadConfig(
  path = CONFIG_PATH,
): Promise<StatuslineConfig> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      quotas: { ...DEFAULT_CONFIG.quotas, ...raw.quotas },
    };
  } catch (error) {
    // A missing config is an intentional, zero-setup state; other failures matter.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return DEFAULT_CONFIG;
    throw error;
  }
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
