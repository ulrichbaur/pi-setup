import assert from "node:assert/strict";
import { test } from "node:test";
import { resultText } from "../../../extensions/subagents/render.ts";
import { fakeRun } from "./fake-run.ts";

test("the parent model learns about the user's messages", () => {
  const run = fakeRun("worker-00000001", "completed");
  run.result.output = "Done.";
  run.result.userMessages = ["use pnpm"];
  run.result.sessionFile = "/s/x.jsonl";
  assert.equal(
    resultText(run.result),
    "Done.\n\nThe user sent the subagent these messages while it ran:\n- use pnpm\n\nSession: worker-00000001",
  );
});
