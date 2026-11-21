import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  combinedText,
  resultText,
  statusIcon,
} from "../../../../extensions/background-work/subagents/render.ts";
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

test("each status has its own icon, and a timeout is a warning", () => {
  const theme = {
    fg: (color: string, text: string) => `${color}:${text}`,
  } as unknown as Theme;
  const icons = (
    [
      "pending",
      "running",
      "completed",
      "timed_out",
      "failed",
      "stopped",
      "interrupted",
    ] as const
  ).map((status) =>
    statusIcon(fakeRun("scout-00000001", status).result, theme),
  );
  assert.deepEqual(icons, [
    "dim:○",
    "warning:⟳",
    "success:✓",
    "warning:◷",
    "error:✗",
    "muted:■",
    "muted:■",
  ]);
});

test("parallel headings mark every run that did not complete", () => {
  const results = (
    ["completed", "failed", "timed_out", "stopped", "interrupted"] as const
  ).map((status) => {
    const { result } = fakeRun("scout-00000001", status);
    result.output = "Output.";
    return result;
  });
  const headings = combinedText({ mode: "parallel", results })
    .split("\n")
    .filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, [
    "## scout",
    "## scout (FAILED)",
    "## scout (TIMED OUT)",
    "## scout (STOPPED)",
    "## scout (INTERRUPTED)",
  ]);
});
