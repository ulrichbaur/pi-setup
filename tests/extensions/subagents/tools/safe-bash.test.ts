import assert from "node:assert/strict";
import { test } from "node:test";
import { dangerousCommandReason } from "../../../../extensions/subagents/tools/safe-bash.ts";

test("safe bash blocks destructive system commands", () => {
  assert.match(dangerousCommandReason("sudo reboot") ?? "", /blocked/);
  assert.match(dangerousCommandReason("rm -rf /") ?? "", /blocked/);
  assert.equal(dangerousCommandReason("pnpm test"), null);
});
