import { readFile, stat } from "node:fs/promises";
import {
  type SessionInfo,
  SessionManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { parseSessionFile } from "../../../lib/session-file.ts";
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
