import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Approval,
  type AskApproval,
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
  const asked: Array<[string, boolean]> = [];
  const answer =
    (approval: Approval): AskApproval =>
    async (message, canAllow) => {
      asked.push([message, canAllow]);
      return approval;
    };

  assert.equal(await commandBlockReason("pnpm test", answer("block")), null);
  assert.equal(asked.length, 0);

  assert.equal(
    await commandBlockReason("git commit -m x", answer("run")),
    null,
  );
  assert.match(asked[0][0], /git commit is a parent-session operation/);
  assert.equal(asked[0][1], false);

  assert.match(
    (await commandBlockReason("rm notes.txt", answer("block"))) ?? "",
    /blocked by the user/,
  );
  assert.match(asked[1][0], /rm deletes files\n\nCommand:\nrm notes\.txt/);
  assert.equal(asked[1][1], true);

  await commandBlockReason("git push", answer("block"));
  assert.equal(asked[2][0].match(/git push publishes/g)?.length, 1);
});

test("an allowed kind runs without asking for the rest of the run", async () => {
  const allowed = new Set<string>();
  let questions = 0;
  const ask =
    (approval: Approval): AskApproval =>
    async () => {
      questions += 1;
      return approval;
    };

  assert.equal(
    await commandBlockReason("rm a.txt", ask("allow"), allowed),
    null,
  );
  assert.equal(
    await commandBlockReason("rm b.txt", ask("block"), allowed),
    null,
  );
  assert.equal(questions, 1);

  // A different kind still asks.
  await commandBlockReason("chmod -R 777 .", ask("run"), allowed);
  assert.equal(questions, 2);

  // Commands the headless policy blocks are never remembered.
  await commandBlockReason("rm -rf build", ask("allow"), allowed);
  assert.match(
    (await commandBlockReason("rm -rf build", ask("block"), allowed)) ?? "",
    /blocked by the user/,
  );
  assert.equal(questions, 4);
});
