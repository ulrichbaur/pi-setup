import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseSessionFile } from "../../../lib/session-file.ts";
import { extractSkillUsageEvents } from "./extract.ts";
import type { SkillUsageCollection, SkillUsageEvent } from "./types.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Session = { path: string; parent?: string; events: SkillUsageEvent[] };

/** Scans saved JSONL files directly so listing cannot silently hide bad files. */
export async function collectSkillUsage(
  sessionsDirectory = join(getAgentDir(), "sessions"),
): Promise<SkillUsageCollection> {
  const result: SkillUsageCollection = {
    events: [],
    sessionsAnalyzed: 0,
    errors: [],
  };
  const sessions = new Map<string, Session>();
  async function visit(directory: string): Promise<void> {
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        directory === sessionsDirectory &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return;
      result.errors.push({ sessionFile: directory, message: message(error) });
      return;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, child.name);
      if (child.isDirectory()) await visit(path);
      else if (child.isFile() && child.name.endsWith(".jsonl")) {
        try {
          const parsed = parseSessionFile(await readFile(path, "utf8"), true);
          const events = extractSkillUsageEvents({
            entries: parsed.entries,
            project: parsed.cwd ?? "",
            sessionId: parsed.id ?? null,
          });
          sessions.set(path, {
            path,
            parent: parsed.parentSession
              ? resolve(dirname(path), parsed.parentSession)
              : undefined,
            events,
          });
          result.sessionsAnalyzed += 1;
        } catch (error) {
          result.errors.push({ sessionFile: path, message: message(error) });
        }
      }
    }
  }
  await visit(sessionsDirectory);

  const unique = new Map<string, { event: SkillUsageEvent; depth: number }>();
  for (const session of sessions.values()) {
    let root = session.path;
    let depth = 0;
    const seen = new Set<string>();
    while (!seen.has(root)) {
      seen.add(root);
      const parent = sessions.get(root)?.parent;
      if (!parent) break;
      root = parent;
      depth += 1;
    }
    for (const [index, event] of session.events.entries()) {
      // IDs survive native forks. Missing legacy IDs cannot prove inheritance.
      const key =
        event.entryId === null
          ? JSON.stringify([session.path, index])
          : JSON.stringify([root, event.entryId, event.timestamp, event.skill]);
      const previous = unique.get(key);
      if (!previous || depth < previous.depth)
        unique.set(key, { event, depth });
    }
  }
  result.events = [...unique.values()]
    .map(({ event }) => event)
    .sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  return result;
}
