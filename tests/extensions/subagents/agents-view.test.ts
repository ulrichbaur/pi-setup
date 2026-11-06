import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentsOverlay } from "../../../extensions/subagents/agents-view.ts";
import { RunRegistry } from "../../../extensions/subagents/runs.ts";
import { fakeRun } from "./fake-run.ts";

initTheme("dark");

const KEYS = {
  down: "\x1b[B",
  enter: "\r",
  altEnter: "\x1b\r",
  escape: "\x1b",
  stop: "\x18",
  open: "\x0f",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
};
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function setup() {
  const registry = new RunRegistry();
  const tui = {
    terminal: { rows: 40 },
    requestRender: () => {},
  } as unknown as TUI;
  let closed = false;
  const overlay = new AgentsOverlay(
    tui,
    theme,
    registry,
    () => {
      closed = true;
    },
    { hideThinking: () => false },
  );
  const type = (text: string) => {
    for (const character of text) overlay.handleInput(character);
  };
  const screen = () => overlay.render(100).join("\n");
  return { registry, overlay, type, screen, isClosed: () => closed };
}

test("the list shows runs newest first and opens the selected one", () => {
  const { registry, overlay, screen } = setup();
  registry.add(fakeRun("scout-00000001", "completed"));
  registry.add(fakeRun("analyst-00000002"));
  const list = screen();
  assert.match(list, /Subagents \(2\)/);
  assert.ok(list.indexOf("analyst-00000002") < list.indexOf("scout-00000001"));
  overlay.handleInput(KEYS.down);
  assert.match(screen(), /› ✓ scout scout-00000001/);
  overlay.handleInput(KEYS.enter);
  assert.match(screen(), /Finished: read-only/);
});

test("running and finished transcripts are read-only and cannot switch sessions", () => {
  for (const status of ["running", "completed"] as const) {
    const { registry, overlay, type, screen, isClosed } = setup();
    registry.add(fakeRun("scout-00000001", status));
    overlay.handleInput(KEYS.enter);
    const before = screen();
    type("hello");
    overlay.handleInput(KEYS.enter);
    overlay.handleInput(KEYS.altEnter);
    overlay.handleInput(KEYS.open);
    assert.equal(screen(), before);
    assert.match(screen(), /[Rr]ead-only/);
    assert.doesNotMatch(screen(), /steer|follow-up|open session/);
    assert.equal(isClosed(), false);
  }
});

test("the live transcript scrolls and shows new output without taking input", () => {
  const { registry, overlay, screen } = setup();
  const run = fakeRun("scout-00000001");
  run.result.output = Array.from({ length: 80 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  registry.add(run);
  overlay.handleInput(KEYS.enter);
  assert.match(screen(), /line 79/);
  overlay.handleInput(KEYS.pageUp);
  assert.doesNotMatch(screen(), /line 79/);
  overlay.handleInput(KEYS.pageDown);
  assert.match(screen(), /line 79/);
  run.result.output += "\nnew output";
  registry.changed();
  assert.match(screen(), /new output/);
});

test("Ctrl+X stops one run; Escape goes back, then closes", () => {
  const { registry, overlay, screen, isClosed } = setup();
  const first = fakeRun("scout-00000001");
  const second = fakeRun("analyst-00000002");
  registry.add(first);
  registry.add(second);
  overlay.handleInput(KEYS.stop);
  assert.equal(second.stop.signal.aborted, true);
  assert.equal(first.stop.signal.aborted, false);
  overlay.handleInput(KEYS.down);
  overlay.handleInput(KEYS.enter);
  overlay.handleInput(KEYS.stop);
  assert.equal(first.stop.signal.aborted, true);
  assert.match(screen(), /Stopping this subagent/);
  overlay.handleInput(KEYS.escape);
  assert.match(screen(), /Subagents \(2\)/);
  assert.equal(isClosed(), false);
  overlay.handleInput(KEYS.escape);
  assert.equal(isClosed(), true);
});

test("a long list keeps the selected run visible and fits the overlay", () => {
  const { registry, overlay, screen } = setup();
  for (let i = 0; i < 30; i += 1)
    registry.add(fakeRun(`scout-${String(i).padStart(8, "0")}`));
  for (let i = 0; i < 29; i += 1) overlay.handleInput(KEYS.down);
  assert.ok(screen().split("\n").length <= 34);
  assert.match(screen(), /› ⟳ scout scout-00000000/);
  assert.doesNotMatch(screen(), /scout-00000029/);
});
