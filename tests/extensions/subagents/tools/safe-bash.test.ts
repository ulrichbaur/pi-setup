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

test("the block names each risky step and why", () => {
  assert.equal(
    commandBlockReason("ls && git push"),
    "Command blocked by safe_bash:\n• git push\n  git push publishes to a remote (a parent-session operation)\nUse a safer command, or ask the agent that gave you this task to run it.",
  );
});
