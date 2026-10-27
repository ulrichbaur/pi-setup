import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  readDecisions,
  recordDecision,
} from "../../../extensions/bash-guard/decisions.ts";
import { withTempDir } from "../../helpers.ts";

test("a missing log means nothing was recorded yet", async () => {
  await withTempDir("bash-guard-log-", (directory) => {
    assert.equal(readDecisions(join(directory, "none.jsonl")), undefined);
  });
});

test("records round-trip; unreadable lines are counted, not fatal", async () => {
  await withTempDir("bash-guard-log-", (directory) => {
    const path = join(directory, "nested", "decisions.jsonl");
    const record = {
      time: "2026-10-27T10:00:00.000Z",
      outcome: "rejected" as const,
      findings: [{ command: "rm a.txt", reason: "rm deletes files" }],
      rejectReason: "keep it",
    };
    recordDecision(record, path);
    writeFileSync(path, '{"outcome":"maybe"}\nnot json\n', { flag: "a" });
    assert.deepEqual(readDecisions(path), { records: [record], unreadable: 2 });
  });
});
