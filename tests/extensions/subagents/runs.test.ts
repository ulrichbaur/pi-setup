import assert from "node:assert/strict";
import { test } from "node:test";
import type { RpcChild } from "../../../extensions/subagents/rpc.ts";
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

test("messages reach a running child and are recorded for the parent", async () => {
  const registry = new RunRegistry();
  const run = fakeRun("worker-00000001");
  const sent: unknown[] = [];
  run.child = {
    send: async (command: unknown) => {
      sent.push(command);
    },
  } as unknown as RpcChild;

  await registry.send(run, "  use pnpm  ", "steer");
  await registry.send(run, "then summarize", "followUp");
  await registry.send(run, "   ", "steer");
  assert.deepEqual(sent, [
    { type: "steer", message: "use pnpm" },
    { type: "follow_up", message: "then summarize" },
  ]);
  assert.deepEqual(run.result.userMessages, ["use pnpm", "then summarize"]);

  run.child = undefined;
  await assert.rejects(registry.send(run, "hello", "steer"), /not running/);
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

test("a queued question resolves once: answered, timed out, or aborted", async () => {
  const registry = new RunRegistry();
  const run = fakeRun("worker-00000001");
  let changes = 0;
  registry.subscribe(() => {
    changes += 1;
  });
  const live = new AbortController().signal;

  const answered = registry.ask(run, { method: "confirm" }, 60_000, live);
  assert.equal(run.pendingDialogs.length, 1);
  run.pendingDialogs[0].answer({ confirmed: true });
  run.pendingDialogs[0]?.answer({ confirmed: false });
  assert.deepEqual(await answered, { confirmed: true });
  assert.equal(run.pendingDialogs.length, 0);
  assert.equal(changes, 2);

  const timedOut = registry.ask(run, { method: "confirm" }, 10, live);
  assert.deepEqual(await timedOut, { cancelled: true });
  const childTimeout = registry.ask(
    run,
    { method: "confirm", timeout: 10 },
    60_000,
    live,
  );
  assert.deepEqual(await childTimeout, { cancelled: true });

  const stop = new AbortController();
  const aborted = registry.ask(run, { method: "confirm" }, 60_000, stop.signal);
  stop.abort();
  assert.deepEqual(await aborted, { cancelled: true });
  assert.deepEqual(
    await registry.ask(run, { method: "confirm" }, 60_000, stop.signal),
    { cancelled: true },
  );
  assert.equal(run.pendingDialogs.length, 0);
});
