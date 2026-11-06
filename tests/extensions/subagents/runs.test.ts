import assert from "node:assert/strict";
import { test } from "node:test";
import { RunRegistry } from "../../../extensions/subagents/runs.ts";
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
  registry.stop(done);
  assert.equal(live.stop.signal.aborted, true);
  assert.equal(other.stop.signal.aborted, false);
  assert.equal(done.stop.signal.aborted, false);
});
