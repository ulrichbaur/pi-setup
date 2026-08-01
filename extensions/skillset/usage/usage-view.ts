import type { ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey } from "@earendil-works/pi-tui";
import { aggregateSkillUsage } from "../history/aggregate.ts";
import type { SkillUsageEvent, SkillUsageSummary } from "../history/types.ts";
import {
  summarizeUsageByProject,
  summarizeUsageRates,
  type UsageProjectSummary,
  type UsageTrendSummary,
} from "./usage.ts";

type ThemeLike = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};

type KeybindingsLike = {
  matches(data: string, binding: string): boolean;
};

type TuiLike = {
  requestRender(): void;
};

export type UsageViewOptions = {
  skills?: readonly Pick<Skill, "name" | "filePath">[];
  events: readonly SkillUsageEvent[];
  errors: ReadonlyArray<{ sessionFile: string; message: string }>;
  currentProject: string;
  now?: number;
  tui: TuiLike;
  theme: ThemeLike;
  keybindings: KeybindingsLike;
  done: () => void;
};

export type UsageTrendScope = "all-projects" | "current-project";

export type UsageViewSnapshot = {
  totalCount: number;
  summaries: readonly SkillUsageSummary[];
  selectedIndex: number;
  selected: SkillUsageSummary | undefined;
  projects: readonly UsageProjectSummary[];
  trends: readonly UsageTrendSummary[];
  currentProject: string;
  trendScope: UsageTrendScope;
};

export type ComputeUsageViewOptions = {
  skills?: readonly Pick<Skill, "name" | "filePath">[];
  events: readonly SkillUsageEvent[];
  selectedIndex: number;
  currentProject: string;
  trendScope?: UsageTrendScope;
  now?: number;
};

/** Pure derivation of the view state from inputs; safe to call repeatedly. */
export function computeUsageView(
  options: ComputeUsageViewOptions,
): UsageViewSnapshot {
  const now = options.now ?? Date.now();
  const summaries = aggregateSkillUsage(options.events, options.skills, now);
  const safeIndex = Math.min(
    Math.max(options.selectedIndex, 0),
    Math.max(0, summaries.length - 1),
  );
  const selected = summaries[safeIndex];
  const selectedEvents = selected
    ? options.events.filter((event) => event.skillName === selected.skillName)
    : [];
  const projects = summarizeUsageByProject(selectedEvents);
  const trendScope = options.trendScope ?? "all-projects";
  const trendEvents =
    trendScope === "current-project"
      ? selectedEvents.filter(
          (event) => event.project === options.currentProject,
        )
      : selectedEvents;
  const trends = summarizeUsageRates(trendEvents, now);
  return {
    totalCount: options.events.length,
    summaries,
    selectedIndex: safeIndex,
    selected,
    projects,
    trends,
    currentProject: options.currentProject,
    trendScope,
  };
}

const NAME_WIDTH_DEFAULT = 16;
const COUNT_WIDTH = 5;
const VISIBLE_SKILLS = 8;
const VISIBLE_PROJECTS = 3;

function renderView(
  view: UsageViewSnapshot,
  theme: ThemeLike,
  errors: ReadonlyArray<{ sessionFile: string; message: string }>,
  maxVisibleSkills: number,
): string[] {
  const lines: string[] = [];
  lines.push(theme.bold("Skill invocations"));
  lines.push(
    theme.fg(
      "dim",
      `All-time invocations: ${view.totalCount} across ${view.summaries.length} skills · project: ${view.currentProject}   ↑ ↓ skill   tab trend scope   esc close`,
    ),
  );
  lines.push("");

  lines.push(theme.bold("Skills"));
  if (view.summaries.length === 0) {
    lines.push(theme.fg("dim", "  (no skills found)"));
  } else {
    const nameWidth = Math.min(
      32,
      Math.max(
        NAME_WIDTH_DEFAULT,
        ...view.summaries.map((summary) => summary.skillName.length),
      ),
    );
    lines.push(
      theme.fg(
        "dim",
        `  ${"Skill".padEnd(nameWidth)}  ${"Invocations".padStart(COUNT_WIDTH + 8)}`,
      ),
    );
    const visibleCount = Math.min(maxVisibleSkills, view.summaries.length);
    const visibleStart = Math.min(
      Math.max(0, view.selectedIndex - Math.floor(visibleCount / 2)),
      view.summaries.length - visibleCount,
    );
    const visibleEnd = visibleStart + visibleCount;
    lines.push(
      theme.fg("dim", visibleStart > 0 ? `  ↑ ${visibleStart} more` : " "),
    );
    for (let index = visibleStart; index < visibleEnd; index += 1) {
      const summary = view.summaries[index];
      if (!summary) continue;
      const selected = index === view.selectedIndex;
      const marker = selected ? "▸ " : "  ";
      const row = `${marker}${summary.skillName.padEnd(nameWidth)}  ${String(summary.invocations).padStart(COUNT_WIDTH + 8)}`;
      lines.push(
        selected ? theme.bg("selectedBg", theme.fg("accent", row)) : row,
      );
    }
    lines.push(
      theme.fg(
        "dim",
        visibleEnd < view.summaries.length
          ? `  ↓ ${view.summaries.length - visibleEnd} more`
          : " ",
      ),
    );
  }
  lines.push("");

  if (!view.selected) {
    lines.push(theme.fg("dim", "(pick a skill to see per-project and trend)"));
  } else {
    lines.push(theme.bold(view.selected.skillName));
    const visibleProjects = view.projects.slice(0, VISIBLE_PROJECTS);
    const projectWidth = Math.min(
      48,
      Math.max(12, ...visibleProjects.map((project) => project.project.length)),
    );
    lines.push(theme.fg("dim", "  Per project"));
    lines.push(
      theme.fg(
        "dim",
        `    ${"Project".padEnd(projectWidth)}  ${"Invocations".padStart(COUNT_WIDTH + 8)}`,
      ),
    );
    for (let index = 0; index < VISIBLE_PROJECTS; index += 1) {
      const project = visibleProjects[index];
      if (!project) {
        lines.push(
          index === 0 && view.projects.length === 0
            ? theme.fg("dim", "    (no project usage)")
            : " ",
        );
        continue;
      }
      const isCurrent = project.project === view.currentProject;
      const marker = isCurrent ? "★ " : "  ";
      const label = isCurrent
        ? theme.fg("accent", project.project.padEnd(projectWidth))
        : project.project.padEnd(projectWidth);
      lines.push(
        `  ${marker}${label}  ${String(project.invocations).padStart(COUNT_WIDTH + 8)}`,
      );
    }
    lines.push(
      theme.fg(
        "dim",
        view.projects.length > VISIBLE_PROJECTS
          ? `    ↓ ${view.projects.length - VISIBLE_PROJECTS} more projects`
          : " ",
      ),
    );
    lines.push("");
    const trendLabel =
      view.trendScope === "all-projects"
        ? "all projects"
        : `current project: ${view.currentProject}`;
    lines.push(theme.fg("dim", `  Trend (per day, ${trendLabel})`));
    for (const trend of view.trends) {
      lines.push(
        `    ${trend.window}: ${trend.perDay.toFixed(2)} per day (${trend.total} invocations)`,
      );
    }
  }

  if (errors.length > 0) {
    lines.push("");
    lines.push(
      theme.fg(
        "warning",
        `Warnings: ${errors.length} sessions could not be analyzed`,
      ),
    );
    for (const error of errors.slice(0, 3)) {
      lines.push(theme.fg("dim", `  ${error.sessionFile}: ${error.message}`));
    }
    if (errors.length > 3) {
      lines.push(theme.fg("dim", `  … ${errors.length - 3} more`));
    }
  }

  return lines;
}

/** Builds the live, re-rendering `/usage` TUI view. */
export function buildUsageView(options: UsageViewOptions): Component {
  const now = options.now ?? Date.now();
  let selectedIndex = 0;
  let trendScope: UsageTrendScope = "all-projects";

  function currentView(): UsageViewSnapshot {
    return computeUsageView({
      skills: options.skills,
      events: options.events,
      selectedIndex,
      currentProject: options.currentProject,
      trendScope,
      now,
    });
  }

  return {
    render(_width: number): string[] {
      return renderView(
        currentView(),
        options.theme,
        options.errors,
        VISIBLE_SKILLS,
      );
    },
    invalidate(): void {},
    handleInput(data: string): void {
      const beforeIndex = selectedIndex;
      const beforeScope = trendScope;
      const view = currentView();
      if (options.keybindings.matches(data, "tui.select.up")) {
        selectedIndex = Math.max(0, view.selectedIndex - 1);
      } else if (options.keybindings.matches(data, "tui.select.down")) {
        selectedIndex = Math.min(
          Math.max(0, view.summaries.length - 1),
          view.selectedIndex + 1,
        );
      } else if (matchesKey(data, "tab")) {
        trendScope =
          trendScope === "all-projects" ? "current-project" : "all-projects";
      } else if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.done();
        return;
      }
      if (beforeIndex !== selectedIndex || beforeScope !== trendScope) {
        options.tui.requestRender();
      }
    },
  };
}

/** Convenience wrapper that wires the view into Pi's `ctx.ui.custom` flow. */
export async function showUsageView(options: {
  ctx: ExtensionContext;
  skills: readonly Pick<Skill, "name" | "filePath">[];
  events: readonly SkillUsageEvent[];
  errors: ReadonlyArray<{ sessionFile: string; message: string }>;
  currentProject: string;
}): Promise<void> {
  await options.ctx.ui.custom(
    (tui: unknown, theme: unknown, keybindings: unknown, done: unknown) =>
      buildUsageView({
        skills: options.skills,
        events: options.events,
        errors: options.errors,
        currentProject: options.currentProject,
        tui: tui as TuiLike,
        theme: theme as ThemeLike,
        keybindings: keybindings as KeybindingsLike,
        done: done as () => void,
      }),
  );
}
