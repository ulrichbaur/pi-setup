import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sessionUsage } from "../../../../extensions/background-work/subagents/usage.ts";
import { withTempDir } from "../../../helpers.ts";

test("session usage sums assistant messages from a message entry on", async () => {
  await withTempDir("subagent-usage-", async (root) => {
    const path = join(root, "session.jsonl");
    const message = (role: string, cost?: number) =>
      JSON.stringify({
        type: "message",
        message: {
          role,
          ...(cost !== undefined && {
            usage: { input: 1, output: 2, cacheRead: 3, cost: { total: cost } },
          }),
        },
      });
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "session" }),
        message("user"),
        message("assistant", 0.5),
        "not json",
        JSON.stringify({ type: "model_change" }),
        message("user"),
        message("assistant", 0.25),
        message("assistant"),
      ].join("\n"),
    );
    assert.deepEqual(sessionUsage(path, 0), {
      input: 2,
      output: 4,
      cacheRead: 6,
      cacheWrite: 0,
      cost: 0.75,
      turns: 3,
    });
    // Message entries 0 and 1 belong to an earlier run.
    assert.equal(sessionUsage(path, 2).cost, 0.25);
    assert.throws(() => sessionUsage(join(root, "missing.jsonl"), 0), /ENOENT/);
  });
});
