import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  interruptedResults,
  resultKey,
  savedRuns,
} from "../../../../extensions/background-work/subagents/restore.ts";
import { withTempDir } from "../../../helpers.ts";
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
          { ...result("worker-00000002", "pending"), runId: "run-2" },
          { ...result("worker-00000003", "pending"), runId: "run-3" },
        ],
      }),
      {
        type: "custom_message",
        customType: TYPE,
        details: {
          mode: "single",
          results: [
            { ...result("worker-00000002", "completed"), runId: "run-2" },
            { agent: 1 },
          ],
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
      ["worker-00000003", "interrupted", "Interrupted when its session closed"],
      ["worker-00000002", "completed", undefined],
    ],
  );
});

test("background continuations restore by run ID rather than session ID", () => {
  const sessionId = "scout-00000001";
  const launch = (runId: string) =>
    toolResult("subagent", {
      background: true,
      results: [{ ...result(sessionId, "pending"), runId }],
    });
  const first = { ...result(sessionId, "completed"), runId: "first" };
  const restored = savedRuns(
    [
      launch("first"),
      launch("second"),
      {
        type: "custom_message",
        customType: TYPE,
        details: { results: [first] },
      },
    ],
    TYPE,
  );
  assert.deepEqual(
    restored.map(({ result, undelivered }) => [
      resultKey(result),
      result.progress.status,
      Boolean(undelivered),
    ]),
    [
      ["second", "interrupted", true],
      ["first", "completed", false],
    ],
  );
});

test("interrupted launches report whether their session can be continued", () => {
  const launch = (sessionId: string, runId: string) =>
    toolResult("subagent", {
      background: true,
      results: [{ ...result(sessionId, "pending"), runId }],
    });
  const runs = savedRuns(
    [
      launch("scout-00000001", "saved"),
      launch("scout-00000002", "unsaved"),
      launch("scout-00000003", "delivered"),
      {
        type: "custom_message",
        customType: TYPE,
        details: {
          results: [
            { ...result("scout-00000003", "completed"), runId: "delivered" },
          ],
        },
      },
    ],
    TYPE,
  );
  const results = interruptedResults(runs, (sessionId) =>
    sessionId === "scout-00000001" ? "/missing/session.jsonl" : undefined,
  );
  assert.deepEqual(
    results.map(({ runId, progress }) => [runId, progress.status]),
    [
      ["saved", "interrupted"],
      ["unsaved", "interrupted"],
    ],
  );
  assert.match(
    results[0].output,
    /Its subagent session scout-00000001 is saved\. To finish the work, call subagent with that session/,
  );
  assert.match(results[1].output, /No subagent session was saved/);
  // A session file that cannot be read leaves the cost unknown, visibly.
  assert.match(results[0].output, /Its cost could not be read: .*ENOENT/);
  assert.equal(results[0].usage.cost, 0);
  assert.equal(results[1].progress.lastMessage, results[1].output);
  assert.equal(
    results[0].progress.error,
    "Interrupted when its session closed",
  );
});

/** A session file whose assistant messages each cost `costs[i]`. */
function sessionFile(path: string, costs: number[]): void {
  const lines = [JSON.stringify({ type: "session", id: "x" })];
  for (const cost of costs) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "go" },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [],
          usage: { input: 10, output: 5, cost: { total: cost } },
        },
      }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

test("an interrupted run's cost comes from its own messages in the session file", async () => {
  await withTempDir("restore-usage-", async (root) => {
    mkdirSync(join(root, "sessions"));
    const path = join(root, "sessions", "2026_scout-00000001.jsonl");
    // Two messages from an earlier, delivered run, then two from this run.
    sessionFile(path, [0.01, 0.02]);
    const earlier = {
      ...result("scout-00000001", "completed"),
      runId: "earlier",
      messageEnd: 2,
    };
    const runs = savedRuns(
      [
        toolResult("subagent", { background: true, results: [earlier] }),
        {
          type: "custom_message",
          customType: TYPE,
          details: { results: [earlier] },
        },
        toolResult("subagent", {
          background: true,
          results: [{ ...result("scout-00000001", "pending"), runId: "cut" }],
        }),
      ],
      TYPE,
    );
    const [cut] = interruptedResults(runs, () => path);
    assert.equal(cut.runId, "cut");
    assert.equal(cut.usage.cost, 0.02);
    assert.equal(cut.usage.turns, 1);
    assert.equal(cut.usage.input, 10);
    // The pane can show the run's own transcript.
    assert.equal(cut.sessionFile, path);
    assert.equal(cut.messageStart, 2);
    assert.equal(cut.messageEnd, 4);
  });
});
