import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RunRegistry,
  stoppedBy,
} from "../../../../extensions/background-work/subagents/runs.ts";
import { stopTool } from "../../../../extensions/background-work/subagents/stop.ts";
import { fakeRun } from "./fake-run.ts";

function backgroundRun(runId: string) {
  const run = fakeRun(`scout-${runId}`);
  run.result.runId = runId;
  return run;
}

test("a run that outlasts the wait is reported as still stopping", async () => {
  const registry = new RunRegistry();
  const run = backgroundRun("run-1");
  registry.add(run);
  const result = await stopTool(registry, 20).execute("stop", {
    runId: "run-1",
  });
  assert.equal(stoppedBy(run), "parent");
  assert.equal(result.details.status, "running");
  assert.match(result.content[0].text, /It is still stopping\./);
});

test("the wait ends as soon as the run ends", async () => {
  const registry = new RunRegistry();
  const run = backgroundRun("run-2");
  registry.add(run);
  run.stop.signal.addEventListener("abort", () => {
    setImmediate(() => {
      run.result.progress.status = "failed";
      registry.changed();
    });
  });
  const startedAt = Date.now();
  const result = await stopTool(registry).execute("stop", { runId: "run-2" });
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(result.details.status, "failed");
  assert.match(result.content[0].text, /^Stopped background subagent scout/);
});

test("an aborted tool call stops waiting but keeps the stop", async () => {
  const registry = new RunRegistry();
  const run = backgroundRun("run-3");
  registry.add(run);
  const controller = new AbortController();
  const pending = stopTool(registry).execute(
    "stop",
    { runId: "run-3" },
    controller.signal,
  );
  controller.abort();
  const result = await pending;
  assert.equal(run.stop.signal.aborted, true);
  assert.match(result.content[0].text, /It is still stopping\./);
});

test("foreground runs have no run ID and cannot be stopped by the tool", async () => {
  const registry = new RunRegistry();
  registry.add(fakeRun("scout-foreground"));
  await assert.rejects(
    stopTool(registry).execute("stop", { runId: "scout-foreground" }),
    /Unknown background subagent run/,
  );
});

test("a session stops its active run", async () => {
  const registry = new RunRegistry();
  const run = backgroundRun("run-4");
  registry.add(run);
  const result = await stopTool(registry, 20).execute("stop", {
    session: run.result.sessionId,
  });
  assert.equal(stoppedBy(run), "parent");
  assert.equal(result.details.runId, "run-4");
  assert.match(result.content[0].text, /run ID: run-4, session: scout-run-4/);
});

test("a stop needs exactly one of runId and session", async () => {
  const registry = new RunRegistry();
  const run = backgroundRun("run-5");
  registry.add(run);
  await assert.rejects(
    stopTool(registry).execute("stop", {}),
    /Pass runId or session\./,
  );
  await assert.rejects(
    stopTool(registry).execute("stop", {
      runId: "run-5",
      session: run.result.sessionId,
    }),
    /Pass runId or session, not both\./,
  );
  assert.equal(run.stop.signal.aborted, false);
});
