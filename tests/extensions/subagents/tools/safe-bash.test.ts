import assert from "node:assert/strict";
import { test } from "node:test";
import { commandBlockReason } from "../../../../extensions/subagents/tools/safe-bash.ts";

test("safe bash blocks what either policy catches", () => {
  assert.match(commandBlockReason("sudo reboot") ?? "", /blocked/);
  assert.match(commandBlockReason("rm -rf /") ?? "", /blocked/);
  assert.match(
    commandBlockReason("git commit -m x") ?? "",
    /git commit is a parent-session operation/,
  );
  assert.match(commandBlockReason("rm notes.txt") ?? "", /rm deletes files/);
  assert.equal(commandBlockReason("pnpm test"), null);
});

test("a reason caught by both policies appears once", () => {
  assert.equal(
    commandBlockReason("git push")?.match(/git push publishes/g)?.length,
    1,
  );
});
