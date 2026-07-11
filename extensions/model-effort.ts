/**
 * Remembers a preferred thinking level for each exact provider/model pair,
 * applying the closest supported fallback whenever that model becomes active.
 * This lets you cycle through models without losing the effort level saved for each model.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Ordered by effort so an unsupported level can use the closest lower level.
const LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const FILE = join(AGENT_DIR, "model-effort.json");

type Preferences = Record<string, ThinkingLevel>;

// Keep preferences isolated by exact provider/model identity.
const keyOf = (model: Model<Api>) => `${model.provider}/${model.id}`;

// Use the saved level, or the closest supported level below it.
function preferredLevel(
  model: Model<Api>,
  saved?: ThinkingLevel,
): ThinkingLevel {
  const levels = getSupportedThinkingLevels(model).filter(
    (level) => level !== "off",
  );
  if (levels.length === 0) return "minimal";
  if (!saved) return levels[0];
  const savedIndex = LEVELS.indexOf(saved);
  return (LEVELS.slice(1, savedIndex + 1).findLast((level) =>
    levels.includes(level as ThinkingLevel),
  ) ?? levels[0]) as ThinkingLevel;
}

// Ignore missing, malformed, or invalid preference data.
async function load(): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(FILE, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, ThinkingLevel] =>
        LEVELS.includes(entry[1] as ThinkingLevel),
      ),
    );
  } catch {
    return {};
  }
}

// Write sorted preferences atomically with user-only permissions.
async function save(preferences: Preferences): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  const sorted = Object.fromEntries(
    Object.entries(preferences).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(temporary, `${JSON.stringify(sorted, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, FILE);
}

export default async function modelEffort(pi: ExtensionAPI) {
  const preferences = await load();
  let currentModelKey: string | undefined;
  let applying = false;
  // Serialize writes so rapid events cannot save preferences out of order.
  let writeQueue = Promise.resolve();

  // Copy the current preferences and queue them behind earlier writes.
  const persist = () => {
    const snapshot = { ...preferences };
    writeQueue = writeQueue.then(() => save(snapshot)).catch(() => undefined);
  };

  // Save the default on first use and apply the model's saved level or fallback.
  const apply = (model: Model<Api>) => {
    currentModelKey = keyOf(model);
    const levels = getSupportedThinkingLevels(model).filter(
      (level) => level !== "off",
    );
    const level = preferredLevel(model, preferences[currentModelKey]);

    // Do not let the previous model determine a new model's default level.
    if (levels.length > 0 && !preferences[currentModelKey]) {
      preferences[currentModelKey] = level;
      persist();
    }

    if (pi.getThinkingLevel() !== level) {
      // Suppress the thinking_level_select event emitted by our own update.
      applying = true;
      try {
        pi.setThinkingLevel(level);
      } finally {
        applying = false;
      }
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.model) apply(ctx.model);
  });

  pi.on("model_select", (event) => {
    apply(event.model);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (applying || !ctx.model) return;
    const eventModelKey = keyOf(ctx.model);
    // Pi may change the new model's effort level before model_select restores its saved level.
    if (eventModelKey !== currentModelKey) return;
    if (event.level === "off") return;
    preferences[eventModelKey] = event.level;
    persist();
  });
}
