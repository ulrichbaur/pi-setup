import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SkillUsageEvent } from "./types.ts";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function timestampOf(entry: SessionEntry): number | undefined {
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function invocationIdentity(entry: { content: unknown }): {
  name?: string;
  location?: string;
} {
  const content = textContent(entry.content);
  return {
    name: content.match(/<skill name="([^"]+)"/)?.[1],
    location: content.match(/\blocation="([^"]+)"/)?.[1],
  };
}

/** Extracts explicit native skill invocations from one session. */
export function extractSkillUsageEvents(options: {
  entries: readonly SessionEntry[];
  skillNames: ReadonlySet<string>;
  project: string;
}): SkillUsageEvent[] {
  const { entries, skillNames, project } = options;
  const events: SkillUsageEvent[] = [];

  for (const entry of entries) {
    const timestamp = timestampOf(entry);
    if (timestamp === undefined) continue;

    if (entry.type !== "message" || entry.message.role !== "user") continue;

    const { name, location } = invocationIdentity(entry.message);
    if (!name || !location) continue;
    if (!skillNames.has(name)) continue;

    events.push({ skillName: name, project, timestamp, sourceId: entry.id });
  }

  return events;
}
