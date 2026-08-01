import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillUsageEvent, SkillUsageSummary } from "./types.ts";

/**
 * Identity survives copied history in forked and cloned session files.
 * Project and session identity are deliberately excluded: a fork copies
 * history into a different session file, possibly under a different
 * project, and those copies must still deduplicate. Unrelated events only
 * collide on an identical random entry id at an identical timestamp.
 */
export function usageEventKey(event: SkillUsageEvent): string {
  return [event.skillName, event.timestamp, event.sourceId].join("\0");
}

export function deduplicateSkillUsageEvents(
  events: readonly SkillUsageEvent[],
): SkillUsageEvent[] {
  const unique = new Map<string, SkillUsageEvent>();
  for (const event of events) {
    if (!unique.has(usageEventKey(event)))
      unique.set(usageEventKey(event), event);
  }
  return [...unique.values()];
}

const FRECENCY_HALF_LIFE_MS = 30 * 86_400_000;

/**
 * Combined frequency/recency weight of one invocation:
 * 1 when it just happened, halved every 30 days, never negative age.
 */
export function frecencyWeight(timestamp: number, now: number): number {
  return 2 ** (-Math.max(0, now - timestamp) / FRECENCY_HALF_LIFE_MS);
}

/** Aggregates explicit user invocations without discarding project identity. */
export function aggregateSkillUsage(
  events: readonly SkillUsageEvent[],
  skills: readonly Pick<Skill, "name" | "filePath">[] = [],
  now: number = Date.now(),
): SkillUsageSummary[] {
  const summaries = new Map<string, SkillUsageSummary>();

  for (const skill of skills) {
    summaries.set(skill.name, {
      skillName: skill.name,
      invocations: 0,
      frecency: 0,
    });
  }

  for (const event of deduplicateSkillUsageEvents(events)) {
    let summary = summaries.get(event.skillName);
    if (!summary) {
      summary = {
        skillName: event.skillName,
        invocations: 0,
        frecency: 0,
      };
      summaries.set(event.skillName, summary);
    }

    summary.invocations += 1;
    summary.frecency += frecencyWeight(event.timestamp, now);
  }

  return [...summaries.values()].sort(
    (left, right) =>
      right.frecency - left.frecency ||
      left.skillName.localeCompare(right.skillName),
  );
}
