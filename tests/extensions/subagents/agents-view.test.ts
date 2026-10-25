import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  AgentsOverlay,
  type OverlayChoice,
} from "../../../extensions/subagents/agents-view.ts";
import { resultText } from "../../../extensions/subagents/index.ts";
import {
  type MessageMode,
  RunRegistry,
  type SubagentRun,
} from "../../../extensions/subagents/runs.ts";
import { fakeRun } from "./fake-run.ts";

const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  altEnter: "\x1b\r",
  escape: "\x1b",
  stop: "\x18",
  open: "\x0f",
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function setup() {
  const registry = new RunRegistry();
  const sent: Array<{ run: SubagentRun; text: string; mode: MessageMode }> = [];
  registry.send = async (run, text, mode) => {
    sent.push({ run, text, mode });
  };
  const tui = {
    terminal: { rows: 40 },
    requestRender: () => {},
  } as unknown as TUI;
  let closed = false;
  let choice: OverlayChoice;
  const overlay = new AgentsOverlay(tui, theme, registry, (chosen) => {
    closed = true;
    choice = chosen;
  });
  overlay.focused = true;
  const type = (text: string) => {
    for (const character of text) overlay.handleInput(character);
  };
  // Drops the input's cursor markers.
  const screen = () =>
    overlay
      .render(100)
      .join("\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes.
      .replace(/\x1b_[^\x07]*\x07/g, "");
  return {
    registry,
    overlay,
    sent,
    type,
    screen,
    isClosed: () => closed,
    choice: () => choice,
  };
}

test("the list shows runs newest first and opens the selected one", () => {
  const { registry, overlay, screen } = setup();
  registry.add(fakeRun("scout-00000001", "completed"));
  registry.add(fakeRun("worker-00000002"));
  const list = screen();
  assert.match(list, /Subagents \(2\)/);
  assert.ok(list.indexOf("worker-00000002") < list.indexOf("scout-00000001"));
  assert.match(list, /› ⟳ scout worker-00000002/);

  overlay.handleInput(KEYS.down);
  assert.match(screen(), /› ✓ scout scout-00000001/);
  overlay.handleInput(KEYS.enter);
  assert.match(screen(), /Finished: read-only/);
});

test("a running subagent takes steering and follow-up messages", async () => {
  const { registry, overlay, sent, type, screen } = setup();
  const run = fakeRun("worker-00000002");
  registry.add(run);
  overlay.handleInput(KEYS.enter);
  assert.match(screen(), /Enter steer · Alt\+Enter follow-up/);

  type("use pnpm");
  overlay.handleInput(KEYS.enter);
  type("then summarize");
  overlay.handleInput(KEYS.altEnter);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.map(({ text, mode }) => [text, mode]),
    [
      ["use pnpm", "steer"],
      ["then summarize", "followUp"],
    ],
  );
  assert.equal(sent[0].run, run);
  assert.match(screen(), /Queued\. The subagent reads it when it would stop/);
});

test("a failed message returns to the input with the reason", async () => {
  const { registry, overlay, type, screen } = setup();
  registry.send = async () => {
    throw new Error("This subagent is not running");
  };
  registry.add(fakeRun("worker-00000002"));
  overlay.handleInput(KEYS.enter);
  type("hello");
  overlay.handleInput(KEYS.enter);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(screen(), /This subagent is not running/);
  assert.match(screen(), /› .*hello/);
});

test("Ctrl+X stops one run; Escape goes back, then closes", () => {
  const { registry, overlay, screen, isClosed } = setup();
  const first = fakeRun("worker-00000001");
  const second = fakeRun("worker-00000002");
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

test("typing does nothing for a finished run", () => {
  const { registry, overlay, sent, type, screen } = setup();
  registry.add(fakeRun("scout-00000001", "completed"));
  overlay.handleInput(KEYS.enter);
  type("hello");
  overlay.handleInput(KEYS.enter);
  assert.equal(sent.length, 0);
  assert.doesNotMatch(screen(), /hello/);
});

test("the parent model learns about the user's messages", () => {
  const run = fakeRun("worker-00000001", "completed");
  run.result.output = "Done.";
  run.result.userMessages = ["use pnpm"];
  run.result.sessionFile = "/s/x.jsonl";
  assert.equal(
    resultText(run.result),
    "Done.\n\nThe user sent the subagent these messages while it ran:\n- use pnpm\n\nSession: worker-00000001",
  );
});

test("Ctrl+O closes the overlay and asks to open the session", () => {
  const { registry, overlay, isClosed, choice } = setup();
  registry.add(fakeRun("scout-00000001", "completed"));
  overlay.handleInput(KEYS.enter);
  overlay.handleInput(KEYS.open);
  assert.equal(isClosed(), true);
  assert.deepEqual(choice(), { open: "scout-00000001" });
});

test("a long list keeps the selected run visible and fits the overlay", () => {
  const { registry, overlay, screen } = setup();
  for (let index = 0; index < 30; index += 1) {
    registry.add(fakeRun(`scout-${String(index).padStart(8, "0")}`));
  }
  for (let index = 0; index < 29; index += 1) overlay.handleInput(KEYS.down);
  const lines = screen().split("\n");
  // The fake terminal has 40 rows; the overlay uses 85% of them.
  assert.ok(lines.length <= 34, `${lines.length} lines`);
  assert.match(screen(), /› ⟳ scout scout-00000000/);
  assert.doesNotMatch(screen(), /scout-00000029/);
});
