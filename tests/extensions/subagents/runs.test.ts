import assert from "node:assert/strict";
import { test } from "node:test";
import { RunRegistry, stoppedBy } from "../../../extensions/subagents/runs.ts";
import { fakeRun } from "./fake-run.ts";

test("the registry lists runs newest first and finds active sessions", () => {
  const registry = new RunRegistry();
  let changes = 0;
  registry.subscribe(() => {
    changes += 1;
  });
  const done = fakeRun("scout-00000001", "completed");
  const live = fakeRun("scout-00000002");
  registry.add(done);
  registry.add(live);
  assert.deepEqual(registry.list(), [live, done]);
  assert.equal(registry.active("scout-00000002"), live);
  assert.equal(registry.active("scout-00000001"), undefined);
  assert.equal(changes, 2);
});

test("only the newest finished runs stay in the list", () => {
  const registry = new RunRegistry();
  const live = fakeRun("scout-live0000");
  registry.add(live);
  for (let index = 0; index < 55; index += 1) {
    registry.add(fakeRun(`scout-${String(index).padStart(8, "0")}`, "failed"));
  }
  const runs = registry.list();
  assert.equal(runs.length, 51);
  assert.ok(runs.includes(live));
  assert.equal(runs[0].result.sessionId, "scout-00000054");
});

test("stop aborts one active run and ignores finished ones", () => {
  const registry = new RunRegistry();
  const live = fakeRun("worker-00000001");
  const other = fakeRun("worker-00000002");
  const done = fakeRun("worker-00000003", "completed");
  registry.stop(live);
  registry.stop(done, "parent");
  assert.equal(live.stop.signal.aborted, true);
  assert.equal(stoppedBy(live), "user");
  assert.equal(stoppedBy(done), undefined);
  assert.equal(other.stop.signal.aborted, false);
  assert.equal(done.stop.signal.aborted, false);
});

test("find selects a background run by run ID or by session", () => {
  const registry = new RunRegistry();
  const background = (
    sessionId: string,
    runId: string,
    status?: "completed",
  ) => {
    const run = fakeRun(sessionId, status);
    run.result.runId = runId;
    registry.add(run);
    return run;
  };
  const older = background("scout-00000001", "run-1", "completed");
  const active = background("scout-00000001", "run-2");
  const newer = background("scout-00000001", "run-3", "completed");
  const finished = background("scout-00000002", "run-4", "completed");
  const latest = background("scout-00000002", "run-5", "completed");
  registry.add(fakeRun("scout-00000003"));

  assert.equal(registry.find({ runId: "run-1" }), older);
  // The active run wins over newer finished runs of the same session.
  assert.equal(registry.find({ session: "scout-00000001" }), active);
  assert.notEqual(registry.find({ session: "scout-00000001" }), newer);
  // Without an active run, the newest run of the session wins.
  assert.equal(registry.find({ session: "scout-00000002" }), latest);
  assert.notEqual(registry.find({ session: "scout-00000002" }), finished);

  // Foreground runs have no run ID and are never found.
  assert.throws(
    () => registry.find({ session: "scout-00000003" }),
    /Unknown background subagent run for session: scout-00000003/,
  );
  assert.throws(
    () => registry.find({ runId: "run-9" }),
    /Unknown background subagent run: run-9/,
  );
  assert.throws(
    () => registry.find({ runId: "run-1", session: "scout-00000001" }),
    /Pass runId or session, not both\./,
  );
  assert.throws(() => registry.find({}), /Pass runId or session\./);
});
