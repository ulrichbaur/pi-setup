import assert from "node:assert/strict";
import { test } from "node:test";
import { savedRuns } from "../../../extensions/subagents/restore.ts";
import { fakeRun } from "./fake-run.ts";

const TYPE = "subagent-result";

function result(sessionId: string, status: "completed" | "failed" | "pending") {
  return fakeRun(sessionId, status).result;
}

function toolResult(toolName: string, details: unknown) {
  return {
    type: "message",
    message: { role: "toolResult", toolName, details },
  };
}

test("saved tool results and delivered messages become finished runs", () => {
  const runs = savedRuns(
    [
      { type: "session" },
      toolResult("subagent", {
        mode: "single",
        results: [result("scout-00000001", "completed")],
      }),
      toolResult("read", { results: [result("scout-99999999", "completed")] }),
      toolResult("subagent", {
        mode: "parallel",
        background: true,
        results: [
          result("worker-00000002", "pending"),
          result("worker-00000003", "pending"),
        ],
      }),
      {
        type: "custom_message",
        customType: TYPE,
        details: {
          mode: "single",
          results: [result("worker-00000002", "completed"), { agent: 1 }],
        },
      },
      { type: "custom_message", customType: "other", details: {} },
    ],
    TYPE,
  );
  assert.deepEqual(
    runs.map(({ result }) => [
      result.sessionId,
      result.progress.status,
      result.progress.error,
    ]),
    [
      ["scout-00000001", "completed", undefined],
      ["worker-00000003", "failed", "Stopped when its session closed"],
      ["worker-00000002", "completed", undefined],
    ],
  );
  assert.ok(runs.every((run) => run.pendingDialogs.length === 0));
});
