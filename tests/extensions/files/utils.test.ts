import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDisplayPath,
  parseGitStatusOutput,
} from "../../../extensions/files/utils.ts";

test("display paths are relative only within the working directory", () => {
  assert.equal(formatDisplayPath("/project/src/a.ts", "/project"), "src/a.ts");
  assert.equal(
    formatDisplayPath("/project-other/a.ts", "/project"),
    "/project-other/a.ts",
  );
  assert.equal(formatDisplayPath("/other/a.ts", "/project"), "/other/a.ts");
  assert.equal(formatDisplayPath("/project/a.ts", "/"), "project/a.ts");
});

test("porcelain status preserves both columns and special filenames", () => {
  assert.deepEqual(
    parseGitStatusOutput(" M space name.ts\0A  line\nbreak.ts\0?? other.ts\0"),
    [
      { status: " M", path: "space name.ts" },
      { status: "A ", path: "line\nbreak.ts" },
      { status: "??", path: "other.ts" },
    ],
  );
});

test("rename and copy records consume the original path field", () => {
  assert.deepEqual(
    parseGitStatusOutput(
      "R  new.ts\0old.ts\0C  copy.ts\0original.ts\0 D gone.ts\0",
    ),
    [
      { status: "R ", path: "new.ts", origPath: "old.ts" },
      { status: "C ", path: "copy.ts", origPath: "original.ts" },
      { status: " D", path: "gone.ts" },
    ],
  );
  assert.deepEqual(parseGitStatusOutput(""), []);
});
