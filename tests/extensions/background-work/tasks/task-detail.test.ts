import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { readJob } from "../../../../extensions/background-work/tasks/runner.ts";
import { TaskDetail } from "../../../../extensions/background-work/tasks/task-detail.ts";
import { withTempDir } from "../../../helpers.ts";
import { record, session } from "./fake-jobs.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => `[${text}]`,
} as unknown as Theme;
const BINDINGS: Record<string, string> = {
  "tui.select.cancel": "\x1b",
  "tui.select.confirm": "\r",
  "tui.select.up": "\x1b[A",
  "tui.select.down": "\x1b[B",
  "tui.select.pageUp": "\x1b[5~",
  "tui.select.pageDown": "\x1b[6~",
};
const keys = {
  matches: (data: string, id: string) => BINDINGS[id] === data,
} as unknown as KeybindingsManager;
const tui = { requestRender: () => {} } as unknown as TUI;
const ID = "aaaaaaaa-0000-4000-8000-000000000001";

async function setup(root: string) {
  const dir = record(root, ID, {
    label: "Build",
    command: "make",
    startedAt: new Date().toISOString(),
  });
  writeFileSync(
    join(dir, "output.log"),
    `${Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n")}\n`,
  );
  const stops: string[] = [];
  const pane = new TaskDetail(
    tui,
    theme,
    keys,
    { job: readJob(dir), state: "running", dir },
    {
      stop: (id) => {
        stops.push(id);
        return true;
      },
      refresh: async () => {},
      displayId: (id) => id.slice(0, 5),
    },
  );
  const view = async () => {
    await delay(50);
    return pane.render(100, 19);
  };
  const type = (text: string) => {
    for (const key of text) pane.handleInput(key);
  };
  return { pane, stops, view, type };
}

test("the pane fits its height and follows the end of the log", async () => {
  await withTempDir("pi-task-detail-", async (root) => {
    const { view } = await setup(root);
    const { lines, hint, notice } = await view();
    assert.ok(lines.length + 1 <= 19);
    assert.equal(notice, undefined);
    assert.deepEqual(lines.slice(0, 4), [
      "Build",
      lines[1],
      "Command: make",
      `Log: …/${session}/${ID}/output.log`,
    ]);
    assert.match(lines[1], /^Running · \d+s · Task aaaaa$/);
    assert.equal(lines[4], "Output (following) · lines 29–40 of 40");
    assert.equal(lines.at(-1), "40  line-40");
    assert.match(hint, /c full command · w wrap · \/\? search/);
    assert.match(hint, /x stop · Esc close$/);
  });
});

test("keys expand the command, wrap, search, stop, and go back", async () => {
  await withTempDir("pi-task-detail-", async (root) => {
    const { pane, stops, view, type } = await setup(root);
    await view();
    type("c");
    assert.match((await view()).hint, /^c collapse command/);
    type("c");
    type("w");
    assert.match((await view()).hint, /w unwrap/);

    type("/");
    type("line-3");
    pane.handleInput("\r");
    // Search starts at the first visible line, 29.
    assert.match((await view()).lines[4], /Match on line 30$/);
    type("n");
    assert.match((await view()).lines[4], /Match on line 31$/);
    type("N");
    assert.match((await view()).lines[4], /Match on line 30$/);

    type("x");
    assert.deepEqual(stops, [ID]);
    assert.equal(pane.handleInput("\x1b"), "back");
    pane.dispose();
  });
});
