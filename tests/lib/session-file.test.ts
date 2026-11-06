import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionFile } from "../../lib/session-file.ts";

const header = JSON.stringify({
  type: "session",
  id: "session",
  cwd: "/project",
  parentSession: "/parent.jsonl",
});

test("read-only parser retains session provenance", () => {
  assert.deepEqual(parseSessionFile(header, true), {
    id: "session",
    cwd: "/project",
    parentSession: "/parent.jsonl",
    entries: [],
  });
});

test("strict exports report partial final lines while tolerant callers retain their behavior", () => {
  assert.throws(
    () => parseSessionFile(`${header}\n{`, true),
    /malformed session line 2/,
  );
  assert.deepEqual(parseSessionFile(`${header}\n{`).entries, []);
  for (const entry of ["null", "[]", "{}", '{"type":"message"}']) {
    assert.throws(
      () => parseSessionFile(`${header}\n${entry}`, true),
      /invalid session/,
    );
  }
});
