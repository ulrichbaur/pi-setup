import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLoadedSkills } from "../core.ts";
import { collectSkillUsage } from "../history/sessions.ts";
import type { SkillUsageEvent } from "../history/types.ts";
import { showUsageView } from "./usage-view.ts";

export const USAGE_WINDOWS = ["7d", "14d", "30d", "90d"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

const WINDOW_DAYS: Record<UsageWindow, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

export function filterUsageEventsByWindow(
  events: readonly SkillUsageEvent[],
  window: UsageWindow,
  now: number = Date.now(),
): SkillUsageEvent[] {
  const cutoff = now - WINDOW_DAYS[window] * 86_400_000;
  return events.filter(
    (event) => event.timestamp >= cutoff && event.timestamp <= now,
  );
}

export type UsageProjectSummary = { project: string; invocations: number };

export function summarizeUsageByProject(
  events: readonly SkillUsageEvent[],
): UsageProjectSummary[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.project, (counts.get(event.project) ?? 0) + 1);
  }
  return [...counts]
    .map(([project, invocations]) => ({ project, invocations }))
    .sort(
      (left, right) =>
        right.invocations - left.invocations ||
        left.project.localeCompare(right.project),
    );
}

export type UsageTrendSummary = {
  window: UsageWindow;
  total: number;
  perDay: number;
};

export function summarizeUsageRates(
  events: readonly SkillUsageEvent[],
  now: number = Date.now(),
): UsageTrendSummary[] {
  return USAGE_WINDOWS.map((window) => {
    const total = filterUsageEventsByWindow(events, window, now).length;
    return { window, total, perDay: total / WINDOW_DAYS[window] };
  });
}

export default function skillUsage(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description:
      "Live explicit user skill invocations by skill, project, and period",
    handler: async (args, ctx) => {
      try {
        if (args.trim()) throw new Error("`/usage` has no arguments");
        if (ctx.mode !== "tui") {
          ctx.ui.notify("The skill usage view requires TUI mode", "error");
          return;
        }
        const skills = getLoadedSkills(ctx);
        if (skills.length === 0) {
          ctx.ui.notify("No skills are loaded", "warning");
          return;
        }
        ctx.ui.notify("Analyzing skill invocations…", "info");
        const collection = await collectSkillUsage(skills);
        await showUsageView({
          ctx,
          skills,
          events: collection.events,
          errors: collection.errors,
          currentProject: ctx.cwd,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Skill usage: ${message}`, "error");
      }
    },
  });
}
