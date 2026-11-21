import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { Snapshot } from "../../../extensions/background-work/rows.ts";
import { RunRegistry } from "../../../extensions/background-work/subagents/runs.ts";
import type { JobRegistry } from "../../../extensions/background-work/tasks/registry.ts";
import { readJob } from "../../../extensions/background-work/tasks/runner.ts";
import {
  BackgroundView,
  type ViewSources,
} from "../../../extensions/background-work/view.ts";
import { withTempDir } from "../../helpers.ts";
import { KEYS, keys } from "./fake-keys.ts";
import { fakeRun } from "./subagents/fake-run.ts";
import { record } from "./tasks/fake-jobs.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;
const JOB = "a1f03e00-0000-4000-8000-000000000001";
const PAST = "c2000000-0000-4000-8000-000000000002";

async function setup(root: string, fields: Partial<ViewSources> = {}) {
  const live = record(root, JOB, {
    label: "Build",
    // A minute before the subagent, so the subagent is the newest.
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  writeFileSync(join(live, "output.log"), "compiling\n");
  const past = record(root, PAST, {
    state: "exited",
    exitCode: 2,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:14.000Z",
  });
  const snapshot: Snapshot = {
    rows: [
      { job: readJob(live), state: "running", dir: live },
      { job: readJob(past), state: "exited", dir: past },
    ],
    errors: [],
  };
  const stopped: string[] = [];
  const jobs = {
    stop: (id: string) => {
      stopped.push(id);
      return true;
    },
    subscribe: () => () => {},
  } as unknown as JobRegistry;
  const runs = new RunRegistry();
  const done = fakeRun("scout-77aa01bc", "completed");
  const busy = fakeRun("scout-1a2b3c4d");
  busy.startedAt = Date.now();
  runs.add(done);
  runs.add(busy);
  let closed = false;
  const view = new BackgroundView(
    { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
    theme,
    keys,
    () => {
      closed = true;
    },
    {
      tasks: { registry: jobs, load: async () => snapshot },
      subagents: { registry: runs, hideThinking: () => false },
      unavailable: [],
      ...fields,
    },
    snapshot,
  );
  const screen = () => view.render(100).join("\n");
  return { view, screen, stopped, busy, isClosed: () => closed };
}

test("the list shows active work, then each kind's history", async () => {
  await withTempDir("pi-background-view-", async (root) => {
    const { view, screen } = await setup(root);
    const lines = screen()
      .split("\n")
      .map((line) => line.replace(/^│ | *│$/g, "").trimEnd())
      .filter((line) => line && !/^[╭╰]/.test(line));
    assert.equal(lines[0], "Background work");
    assert.equal(lines[1], "Active");
    assert.match(
      lines[2],
      /^> agent {2}scout-1a2b3c4d {2}Running · \ds +task of scout-1a2b3c4d$/,
    );
    assert.match(lines[3], /^ {2}task {3}a1f03 +Running · 1m 0s +Build$/);
    assert.equal(lines[4], "Shell history");
    assert.match(
      lines[5],
      /^ {2}task {3}c2000 +Failed \(exit 2\) · 14s +npm test|true$/,
    );
    assert.equal(lines[6], "Subagent history");
    assert.match(lines[7], /^ {2}agent {2}scout-77aa01bc {2}Completed · 0s/);
    assert.equal(
      lines.at(-1),
      "↑↓ select · Enter details · x stop · Esc close",
    );
    view.dispose();
  });
});

test("the cursor crosses sections and opens the matching pane", async () => {
  await withTempDir("pi-background-view-", async (root) => {
    const { view, screen, isClosed } = await setup(root);
    view.handleInput(KEYS.down);
    assert.match(screen(), /> task {3}a1f03/);
    view.handleInput(KEYS.enter);
    await delay(50);
    assert.match(screen(), /Command: true/);
    assert.match(screen(), /1 {2}compiling/);
    view.handleInput(KEYS.escape);
    assert.match(screen(), /Background work/);
    view.handleInput(KEYS.down);
    view.handleInput(KEYS.down);
    assert.match(screen(), /> agent {2}scout-77aa01bc/);
    view.handleInput(KEYS.enter);
    assert.match(screen(), /Finished: read-only/);
    view.handleInput(KEYS.escape);
    assert.equal(isClosed(), false);
    view.handleInput(KEYS.escape);
    assert.equal(isClosed(), true);
  });
});

test("x stops the selected job or subagent", async () => {
  await withTempDir("pi-background-view-", async (root) => {
    const { view, stopped, busy } = await setup(root);
    view.handleInput("x");
    assert.equal(busy.stop.signal.aborted, true);
    view.handleInput(KEYS.down);
    view.handleInput("x");
    assert.deepEqual(stopped, [JOB]);
    view.dispose();
  });
});

test("a feature that failed to load shows its error in the list", async () => {
  await withTempDir("pi-background-view-", async (root) => {
    const { view, screen } = await setup(root, {
      subagents: undefined,
      unavailable: ["Subagents unavailable: subagents.json: invalid JSON"],
    });
    assert.match(
      screen(),
      /Subagents unavailable: subagents\.json: invalid JSON/,
    );
    assert.match(screen(), /> task {3}a1f03/);
    assert.doesNotMatch(screen(), /agent {2}scout/);
    view.dispose();
  });
});
