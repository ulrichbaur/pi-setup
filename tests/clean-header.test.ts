import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { cleanHeaderText } from "../extensions/clean-header.ts";

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
} as unknown as Theme;

test("cleanHeaderText keeps the compact startup header to two lines", () => {
  const lines = cleanHeaderText(theme).split("\n");

  assert.equal(lines.length, 2);
  assert.equal(lines[0], `pi v${VERSION}`);
  assert.match(lines[1], /interrupt/);
  assert.match(lines[1], /clear\/exit/);
  assert.match(lines[1], /commands/);
  assert.match(lines[1], /bash/);
  assert.match(lines[1], /more/);
  assert.doesNotMatch(
    lines.join("\n"),
    /startup help|loaded resources|Pi can explain/,
  );
});
