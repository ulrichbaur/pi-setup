import assert from "node:assert/strict";
import { test } from "node:test";
import { LogViewport } from "../../../extensions/background-tasks/log-viewport.ts";
import type { LogPage } from "../../../extensions/background-tasks/task-store.ts";

function page(overrides: Partial<LogPage> = {}): LogPage {
  return {
    start: 0,
    end: 100,
    size: 100,
    firstLine: 1,
    totalLines: 5,
    lines: ["first", "abcdefghijklmnopqrstuvwxyz", "third", "fourth", "fifth"],
    ...overrides,
  };
}

function viewport() {
  return new LogViewport((text) => text);
}

test("paused output stays anchored through wrapping, resizing, and command expansion", () => {
  const view = viewport();
  view.layout(13, 2, "");
  view.setPage(page(), false);
  view.pause();
  view.scroll(1);
  assert.equal(view.firstVisibleLine(), 2);
  view.toggleWrap();
  assert.deepEqual(view.visibleRows(), [
    { line: 2, text: "abcdefghij", continuation: false },
    { line: 2, text: "klmnopqrst", continuation: true },
  ]);
  view.scroll(1);
  assert.equal(view.visibleRows()[0]?.continuation, true);
  view.layout(16, 2, "");
  assert.equal(view.firstVisibleLine(), 2);
  view.layout(16, 0, "");
  view.layout(16, 3, "");
  assert.equal(view.firstVisibleLine(), 2);
  view.toggleWrap();
  assert.equal(view.firstVisibleLine(), 2);
  assert.equal(view.following, false);
});

test("scrolling requests adjacent pages and following stays at the tail", () => {
  const view = viewport();
  view.layout(13, 2, "");
  view.setPage(page({ start: 50, size: 150 }), false);
  assert.deepEqual(view.scroll(-1), { anchor: { before: 50 }, atBottom: true });
  view.setPage(page({ start: 50, size: 150 }), true);
  assert.deepEqual(view.scroll(1), { anchor: { after: 100 }, atBottom: false });
  view.setPage(page(), true);
  assert.deepEqual(view.scroll(1), { atBottom: true });
  view.toggleWrap();
  view.layout(16, 1, "");
  assert.equal(view.firstVisibleLine(), 5);
  assert.equal(view.following, true);
});
