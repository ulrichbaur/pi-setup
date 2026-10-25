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

test("a question to the parent tells it how to answer", () => {
  const run = fakeRun("scout-00000001", "completed");
  run.result.question = "Which database?";
  run.result.sessionFile = "/s/x.jsonl";
  assert.equal(
    resultText(run.result),
    "The subagent asks: Which database?\nAnswer it by continuing the subagent: call subagent with session scout-00000001 and your answer as the task.\n\nSession: scout-00000001",
  );
  run.result.output = "Mapped the parser.";
  assert.match(
    resultText(run.result),
    /^Mapped the parser\.\n\nThe subagent asks:/,
  );
});
