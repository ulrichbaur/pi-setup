import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BashReviewComponent } from "../../../extensions/bash-guard/review.ts";

test("bash review keeps actions visible while a long command scrolls", () => {
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  } as unknown as ConstructorParameters<typeof BashReviewComponent>[0];
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  } as unknown as ConstructorParameters<typeof BashReviewComponent>[1];
  const command = Array.from(
    { length: 100 },
    (_, index) => `line-${index}`,
  ).join("\n");
  const component = new BashReviewComponent(
    tui,
    theme,
    { severity: "high", reasons: ["the command deletes files"] },
    command,
    () => {},
  );

  const firstPage = component.render(60);
  assert.equal(firstPage.length, 20);
  assert.ok(firstPage.some((line) => line.includes("line-0")));
  const commandHeaderIndex = firstPage.findIndex((line) =>
    line.includes("Command (lines 1-"),
  );
  assert.ok(commandHeaderIndex > 0);
  assert.equal(firstPage[commandHeaderIndex - 1], "─".repeat(60));
  const abortIndex = firstPage.findIndex((line) => line.includes("Abort"));
  assert.ok(abortIndex > 0);
  assert.equal(firstPage[abortIndex - 1], "─".repeat(60));
  assert.ok(firstPage.some((line) => line.includes("Run")));
  assert.ok(firstPage.every((line) => visibleWidth(line) <= 60));

  component.handleInput("\x1b[6~");
  const secondPage = component.render(60);
  assert.ok(secondPage.some((line) => line.includes("line-11")));
  assert.ok(!secondPage.some((line) => line.includes("line-0")));
  assert.ok(secondPage.some((line) => line.includes("Abort")));
  assert.ok(secondPage.some((line) => line.includes("Run")));
});
