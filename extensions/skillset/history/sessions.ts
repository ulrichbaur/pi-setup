import { readFile, stat } from "node:fs/promises";
import {
  type SessionEntry,
  type SessionInfo,
  SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { deduplicateSkillUsageEvents } from "./aggregate.ts";
import { extractSkillUsageEvents } from "./extract.ts";
import type { SkillUsageEvent } from "./types.ts";

export type SkillUsageCollection = {
  events: SkillUsageEvent[];
  errors: Array<{ sessionFile: string; message: string }>;
};

type CachedSession = {
  modified: number;
  size: number;
  skillFingerprint: string;
  events: SkillUsageEvent[];
};

const sessionCache = new Map<string, CachedSession>();

function skillFingerprint(skills: readonly Skill[]): string {
  return skills
    .map((skill) => `${skill.name}\0${skill.filePath}`)
    .sort()
    .join("\0");
}

type ParsedSession = { cwd?: string; entries: SessionEntry[] };

/**
 * Read-only JSONL parse of one session file. SessionManager.open would
 * migrate pre-current-version sessions and rewrite them on disk, which a
 * usage scan must never do; it also sanitizes malformed lines away instead
 * of reporting them.
 */
function parseSessionFile(raw: string): ParsedSession {
  const lines = raw.split("\n");
  const entries: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial final line is expected while another process appends.
      if (index === lines.length - 1) continue;
      throw new Error(`malformed session line ${index + 1}`);
    }
  }

  const header = entries[0] as { type?: unknown; cwd?: unknown } | undefined;
  if (header?.type !== "session") {
    throw new Error("not a pi session file");
  }
  return {
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    entries: entries.slice(1) as SessionEntry[],
  };
}

async function analyzeSession(
  info: SessionInfo,
  skillNames: ReadonlySet<string>,
  fingerprint: string,
): Promise<SkillUsageEvent[]> {
  const modified = info.modified.getTime();
  const size = (await stat(info.path)).size;
  const cached = sessionCache.get(info.path);
  if (
    cached?.modified === modified &&
    cached.size === size &&
    cached.skillFingerprint === fingerprint
  ) {
    return cached.events;
  }

  const parsed = parseSessionFile(await readFile(info.path, "utf8"));
  const events = extractSkillUsageEvents({
    entries: parsed.entries,
    skillNames,
    project: parsed.cwd || info.cwd,
  });
  sessionCache.set(info.path, {
    modified,
    size,
    skillFingerprint: fingerprint,
    events,
  });
  return events;
}

/** Collects history across projects while isolating malformed session files. */
export async function collectSkillUsage(
  skills: readonly Skill[],
): Promise<SkillUsageCollection> {
  const sessions = await SessionManager.listAll();
  const skillNames = new Set(skills.map((skill) => skill.name));
  const fingerprint = skillFingerprint(skills);
  const events: SkillUsageEvent[] = [];
  const errors: SkillUsageCollection["errors"] = [];

  for (const session of sessions) {
    try {
      events.push(...(await analyzeSession(session, skillNames, fingerprint)));
    } catch (error) {
      errors.push({
        sessionFile: session.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { events: deduplicateSkillUsageEvents(events), errors };
}
