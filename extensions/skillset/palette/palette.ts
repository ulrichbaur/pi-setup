import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { getLoadedSkills } from "../core.ts";
import { aggregateSkillUsage } from "../history/aggregate.ts";
import {
  collectSkillUsage,
  type SkillUsageCollection,
} from "../history/sessions.ts";
import type { SkillUsageSummary } from "../history/types.ts";
import { showSkillPalette } from "./palette-menu.ts";

/** Orders skills by the usage rows, which carry the frecency sort. */
export function orderSkillsByUsage(
  skills: readonly Skill[],
  summaries: readonly Pick<SkillUsageSummary, "skillName">[],
): Skill[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return summaries
    .map((summary) => byName.get(summary.skillName))
    .filter((skill): skill is Skill => skill !== undefined);
}

// The palette must always open; a slow or broken history scan may
// cost the frecency order, but never more than this delay.
const SORT_SCAN_TIMEOUT_MS = 200;

/**
 * A full history scan usually takes longer than the palette's timeout,
 * so each scan deposits its result here and slow opens reuse the last
 * completed one. Slightly stale is fine for a best-effort sort.
 */
export type UsageCache = { collection?: SkillUsageCollection };

// Most-used-lately first; never-used skills keep their alphabetical tail.
export async function orderSkillsByFrecency(
  skills: Skill[],
  collect: typeof collectSkillUsage = collectSkillUsage,
  cache: UsageCache = {},
): Promise<Skill[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The scan keeps running past a lost race to refresh the cache
    // for the next open, and swallows its own failures.
    const scan = collect(skills).then(
      (collection) => {
        cache.collection = collection;
        return collection;
      },
      () => undefined,
    );
    const collection =
      (await Promise.race([
        scan,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), SORT_SCAN_TIMEOUT_MS);
        }),
      ])) ?? cache.collection;
    if (!collection) return skills;
    return orderSkillsByUsage(
      skills,
      aggregateSkillUsage(collection.events, skills),
    );
  } catch {
    // Usage history is optional context; fall back to name order.
    return skills;
  } finally {
    clearTimeout(timer);
  }
}

export default function skillPalette(pi: ExtensionAPI): void {
  const cache: UsageCache = {};

  // Refresh the usage cache off every prompt, so a palette open finds
  // a current frecency order even when its own scan is too slow. The
  // per-file session cache keeps repeated scans from re-reading history.
  pi.on("before_agent_start", (event) => {
    const skills = [...(event.systemPromptOptions.skills ?? [])];
    if (skills.length > 0) {
      void orderSkillsByFrecency(skills, collectSkillUsage, cache);
    }
  });

  pi.registerCommand("skill", {
    description: "Select a loaded skill command",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The skill palette requires TUI mode", "error");
        return;
      }

      // This is Pi's post-discovery skill collection. In particular, package
      // filters from settings.json have already been applied to this list.
      const skills = getLoadedSkills(ctx);
      if (skills.length === 0) {
        ctx.ui.notify("No skills are loaded", "warning");
        return;
      }

      const selected = await showSkillPalette(
        await orderSkillsByFrecency(skills, collectSkillUsage, cache),
        ctx,
      );
      if (!selected) return;

      // Let Pi perform its native skill expansion when the user submits.
      ctx.ui.setEditorText(`/skill:${selected.name} `);
    },
  });
}
