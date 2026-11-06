import { createHash } from "node:crypto";
import { isRecord } from "../../../lib/is-record.ts";
import type { SkillUsageEvent } from "./types.ts";

/** Matches Pi's complete native wrapper, never XML embedded in prose. */
export function extractSkillUsageEvents(options: {
  entries: readonly unknown[];
  project: string;
  sessionId: string | null;
}): SkillUsageEvent[] {
  const events: SkillUsageEvent[] = [];
  for (const entry of options.entries) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    // Pi stores the expansion in one text block, optionally alongside images.
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content) &&
            isRecord(content[0]) &&
            content[0].type === "text" &&
            content
              .slice(1)
              .every((part) => isRecord(part) && part.type === "image")
          ? content[0].text
          : undefined;
    if (typeof text !== "string") continue;
    const match = text.match(
      /^<skill name="([^"\n]+)" location="([^"\n]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n[\s\S]+)?$/,
    );
    if (!match) continue;
    const [, name, path, expanded] = match;
    if (!name || !path || expanded === undefined) continue;
    // Without the generated header, the historical body is not identifiable.
    const body = expanded.match(
      /^References are relative to [^\n]+\.\n\n([\s\S]*)$/,
    )?.[1];
    const time =
      typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(time))
      throw new Error("invalid explicit invocation timestamp");
    events.push({
      timestamp: new Date(time).toISOString(),
      kind: "explicit",
      skill: {
        name,
        path,
        bodyHash:
          body === undefined
            ? null
            : `sha256:${createHash("sha256").update(body.trim(), "utf8").digest("hex")}`,
      },
      project: options.project,
      sessionId: options.sessionId,
      entryId: typeof entry.id === "string" ? entry.id : null,
    });
  }
  return events;
}
