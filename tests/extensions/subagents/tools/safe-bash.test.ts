import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandBlockReason,
  dangerousCommandReason,
} from "../../../../extensions/subagents/tools/safe-bash.ts";

test("safe bash blocks destructive system commands", () => {
  assert.match(dangerousCommandReason("sudo reboot") ?? "", /blocked/);
  assert.match(dangerousCommandReason("rm -rf /") ?? "", /blocked/);
  assert.equal(dangerousCommandReason("pnpm test"), null);
});

test("without a user, only the headless policy decides", async () => {
  assert.match((await commandBlockReason("git commit -m x")) ?? "", /blocked/);
  assert.equal(await commandBlockReason("rm notes.txt"), null);
});

test("with a user, either policy's catch needs approval", async () => {
  const asked: string[] = [];
  const answer =
    (approve: boolean) => async (_title: string, message: string) => {
      asked.push(message);
      return approve;
    };

  assert.equal(await commandBlockReason("pnpm test", answer(false)), null);
  assert.equal(asked.length, 0);

  assert.equal(await commandBlockReason("git commit -m x", answer(true)), null);
  assert.match(asked[0], /git commit is a parent-session operation/);

  assert.match(
    (await commandBlockReason("rm notes.txt", answer(false))) ?? "",
    /blocked by the user/,
  );
  assert.match(asked[1], /rm deletes files\n\nCommand:\nrm notes\.txt/);

  await commandBlockReason("git push", answer(false));
  assert.equal(asked[2].match(/git push publishes/g)?.length, 1);
});
