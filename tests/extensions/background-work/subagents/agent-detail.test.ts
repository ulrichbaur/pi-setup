import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentDetail } from "../../../../extensions/background-work/subagents/agent-detail.ts";
import { RunRegistry } from "../../../../extensions/background-work/subagents/runs.ts";
import { fakeRun } from "./fake-run.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const tui = { requestRender: () => {} } as unknown as TUI;
const KEYS = {
  escape: "\x1b",
  stop: "x",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
};

function setup() {
  const registry = new RunRegistry();
  const run = fakeRun("scout-00000001");
  run.result.output = Array.from({ length: 80 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  registry.add(run);
  const pane = new AgentDetail(tui, theme, registry, () => run, {
    hideThinking: () => false,
  });
  return { run, pane };
}

test("the pane fits its height and scrolls by pages", () => {
  const { pane } = setup();
  const view = pane.render(100, 10);
  // A header line and eight lines of output fit with the hints.
  assert.equal(view.lines.length, 9);
  assert.match(view.lines[0], /scout scout-00000001 · running/);
  assert.equal(view.lines.at(-1), " line 79");
  assert.match(view.hint, /x stop · Esc back/);
  assert.equal(pane.handleInput(KEYS.pageUp), "handled");
  assert.equal(pane.render(100, 10).lines.at(-1), " line 71");
  pane.handleInput(KEYS.pageDown);
  assert.equal(pane.render(100, 10).lines.at(-1), " line 79");
});

test("x stops the run and shows a notice; Escape asks to go back", () => {
  const { run, pane } = setup();
  pane.handleInput(KEYS.stop);
  assert.equal(run.stop.signal.aborted, true);
  const view = pane.render(100, 10);
  assert.deepEqual(view.notice, {
    text: "Stopping this subagent…",
    error: false,
  });
  // The notice takes a row from the output.
  assert.equal(view.lines.length, 8);
  assert.equal(pane.handleInput(KEYS.escape), "back");
});
