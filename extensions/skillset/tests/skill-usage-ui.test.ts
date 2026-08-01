import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillUsageEvent } from "../history/types.ts";
import {
  filterUsageEventsByWindow,
  summarizeUsageByProject,
  summarizeUsageRates,
  type UsageProjectSummary,
  type UsageTrendSummary,
} from "../usage/usage.ts";

function matchesBinding(data: string, binding: string): boolean {
  const keys: Record<string, string[]> = {
    "tui.select.up": ["\u001b[A"],
    "tui.select.down": ["\u001b[B"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["\u001b", "\u0003"],
  };
  return keys[binding]?.includes(data) ?? false;
}

function event(partial: Partial<SkillUsageEvent>): SkillUsageEvent {
  return {
    skillName: "alpha",
    project: "/project",
    timestamp: 0,
    sourceId: "x",
    ...partial,
  };
}

test("filterUsageEventsByWindow keeps only events within the trailing window", () => {
  const now = Date.parse("2026-01-31T00:00:00Z");
  const events = [
    event({ sourceId: "fresh", timestamp: now - 5 * 86_400_000 }),
    event({ sourceId: "edge", timestamp: now - 14 * 86_400_000 + 1000 }),
    event({ sourceId: "stale", timestamp: now - 14 * 86_400_000 - 1000 }),
    event({ sourceId: "old", timestamp: now - 60 * 86_400_000 }),
    event({ sourceId: "future", timestamp: now + 1000 }),
  ];
  const filtered = filterUsageEventsByWindow(events, "14d", now);
  assert.deepEqual(
    filtered.map((e) => e.sourceId),
    ["fresh", "edge"],
  );
});

test("summarizeUsageByProject groups invocations and sorts by total", () => {
  const events = [
    event({ sourceId: "1", project: "/b" }),
    event({ sourceId: "2", project: "/b" }),
    event({ sourceId: "3", project: "/a" }),
    event({ sourceId: "4", project: "/c" }),
  ];
  const [first, second, third] = summarizeUsageByProject(events);
  assert.deepEqual(
    [first, second, third].map((p: UsageProjectSummary) => p.project),
    ["/b", "/a", "/c"],
  );
  assert.equal(first?.invocations, 2);
});

test("summarizeUsageRates returns all periods with fixed daily rates", () => {
  const now = Date.parse("2026-01-29T12:00:00Z");
  const events = [
    event({
      sourceId: "1",
      timestamp: now - 1 * 86_400_000,
    }),
    event({
      sourceId: "2",
      timestamp: now - 5 * 86_400_000,
    }),
    event({
      sourceId: "3",
      timestamp: now - 20 * 86_400_000,
    }),
    event({
      sourceId: "4",
      timestamp: now - 60 * 86_400_000,
    }),
  ];
  const summaries = summarizeUsageRates(events, now);
  assert.deepEqual(
    summaries.map((summary: UsageTrendSummary) => summary.window),
    ["7d", "14d", "30d", "90d"],
  );
  assert.deepEqual(
    summaries.map((summary: UsageTrendSummary) => summary.total),
    [2, 2, 3, 4],
  );
  assert.equal(summaries[0]?.perDay, 2 / 7);
  assert.equal(summaries[2]?.perDay, 3 / 30);
});

test("live usage view derives rows from a no-event loaded inventory", async () => {
  const { computeUsageView } = await import("../usage/usage-view.ts");
  const view = computeUsageView({
    skills: [
      { name: "alpha", filePath: "/skills/alpha/SKILL.md" },
      { name: "beta", filePath: "/skills/beta/SKILL.md" },
    ],
    events: [],
    selectedIndex: 0,
    currentProject: "/project",
    now: 0,
  });

  assert.equal(view.totalCount, 0);
  assert.deepEqual(
    view.summaries.map(({ skillName, invocations }) => ({
      skillName,
      invocations,
    })),
    [
      { skillName: "alpha", invocations: 0 },
      { skillName: "beta", invocations: 0 },
    ],
  );
  assert.equal(view.selected?.skillName, "alpha");
  assert.deepEqual(view.projects, []);
});

test("live usage view renders all-time usage and navigates skills", async () => {
  const { buildUsageView, computeUsageView } = await import(
    "../usage/usage-view.ts"
  );

  const now = Date.parse("2026-01-31T12:00:00Z");
  const events: SkillUsageEvent[] = [
    {
      skillName: "alpha",
      project: "/home/ub/pi-setup",
      timestamp: now - 2 * 86_400_000,
      sourceId: "1",
    },
    {
      skillName: "alpha",
      project: "/home/ub/pi-setup",
      timestamp: now - 5 * 86_400_000,
      sourceId: "2",
    },
    {
      skillName: "beta",
      project: "/home/ub/agent-skills",
      timestamp: now - 8 * 86_400_000,
      sourceId: "3",
    },
    {
      skillName: "alpha",
      project: "/home/ub/pi-setup",
      timestamp: now - 30 * 86_400_000,
      sourceId: "4",
    },
  ];

  // The all-time view includes every event, while the selected skill's
  // current-project rates cover all four fixed periods.
  const view = computeUsageView({
    events,
    selectedIndex: 0,
    currentProject: "/home/ub/pi-setup",
    now,
  });
  assert.equal(view.totalCount, 4);
  assert.equal(view.summaries.length, 2);
  const alpha = view.selected;
  assert.ok(alpha);
  assert.equal(alpha?.invocations, 3);
  assert.deepEqual(
    view.trends.map((trend) => trend.total),
    [2, 2, 3, 3],
  );

  const betaAllProjects = computeUsageView({
    events,
    selectedIndex: 1,
    currentProject: "/home/ub/pi-setup",
    now,
  });
  const betaCurrentProject = computeUsageView({
    events,
    selectedIndex: 1,
    currentProject: "/home/ub/pi-setup",
    trendScope: "current-project",
    now,
  });
  assert.deepEqual(
    betaAllProjects.trends.map((trend) => trend.total),
    [0, 1, 1, 1],
  );
  assert.deepEqual(
    betaCurrentProject.trends.map((trend) => trend.total),
    [0, 0, 0, 0],
  );

  // Live view: build the component and drive it through key changes.
  const tui = { requestRender: () => {} };
  const component = buildUsageView({
    events,
    errors: [],
    currentProject: "/home/ub/pi-setup",
    now,
    tui,
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      bold: (text: string) => text,
    },
    keybindings: { matches: matchesBinding },
    done: () => {},
  });

  const before = component.render(100);
  assert.match(before.join("\n"), /All-time invocations: 4/);
  assert.match(before.join("\n"), /▸ alpha/);
  assert.match(before.join("\n"), /Trend \(per day, all projects\)/);
  component.handleInput?.("\t");
  assert.match(
    component.render(100).join("\n"),
    /Trend \(per day, current project: \/home\/ub\/pi-setup\)/,
  );

  assert.match(before.join("\n"), /7d: 0\.29 per day \(2 invocations\)/);

  // ↓ moves skill selection; the selected skill's name should appear as the
  // section header below the skill list.
  component.handleInput?.("\u001b[B");
  const afterDownLines = component.render(100);
  const afterDown = afterDownLines.join("\n");
  assert.equal(afterDownLines.length, before.length);
  assert.match(afterDown, /\nbeta\n/, "second skill should become selected");

  // ↑ brings us back to the first skill.
  component.handleInput?.("\u001b[A");
  const afterUp = component.render(100).join("\n");
  assert.match(afterUp, /\nalpha\n/, "first skill should be selected again");

  // Repeated ↓ at the bottom must not leave a hidden, out-of-range index.
  component.handleInput?.("\u001b[B");
  component.handleInput?.("\u001b[B");
  component.handleInput?.("\u001b[A");
  const afterBottomUp = component.render(100).join("\n");
  assert.match(
    afterBottomUp,
    /\nalpha\n/,
    "one ↑ from the bottom should select the previous skill",
  );
  component.handleInput?.("\u001b[B");
  const afterBottomDown = component.render(100).join("\n");
  assert.match(
    afterBottomDown,
    /\nbeta\n/,
    "↓ should return to the bottom skill",
  );
});

test("the skill list windows around the selection with more skills than fit", async () => {
  const { buildUsageView } = await import("../usage/usage-view.ts");
  const arrowDown = `${String.fromCharCode(27)}[B`;
  const skills = Array.from({ length: 12 }, (_, index) => ({
    name: `skill-${String(index + 1).padStart(2, "0")}`,
    filePath: `/skills/skill-${String(index + 1).padStart(2, "0")}/SKILL.md`,
  }));

  const component = buildUsageView({
    skills,
    events: [],
    errors: [],
    currentProject: "/project",
    now: 0,
    tui: { requestRender: () => {} },
    theme: {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    keybindings: { matches: matchesBinding },
    done: () => {},
  });

  const top = component.render(100).join("\n");
  assert.match(top, /▸ skill-01/);
  assert.match(top, /skill-08/);
  assert.doesNotMatch(top, /skill-09/);
  assert.doesNotMatch(top, /↑ \d+ more/);
  assert.match(top, /↓ 4 more/);

  for (let presses = 0; presses < 5; presses += 1) {
    component.handleInput?.(arrowDown);
  }
  const middle = component.render(100).join("\n");
  assert.match(middle, /▸ skill-06/);
  assert.match(middle, /↑ 1 more/);
  assert.match(middle, /↓ 3 more/);

  for (let presses = 0; presses < 6; presses += 1) {
    component.handleInput?.(arrowDown);
  }
  const bottom = component.render(100).join("\n");
  assert.match(bottom, /▸ skill-12/);
  assert.match(bottom, /↑ 4 more/);
  assert.doesNotMatch(bottom, /↓ \d+ more/);
  assert.doesNotMatch(bottom, /skill-04/);
  assert.match(bottom, /skill-05/);
});
