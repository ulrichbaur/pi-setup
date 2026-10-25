import assert from "node:assert/strict";
import { test } from "node:test";
import { Limiter } from "../../../extensions/subagents/limiter.ts";

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the limiter admits tasks in order once a slot frees", async () => {
  const limiter = new Limiter(2);
  const started: string[] = [];
  const gates = { a: gate(), b: gate(), c: gate() };
  const task = (name: keyof typeof gates) =>
    limiter.run(async () => {
      started.push(name);
      await gates[name].opened;
      return name;
    });

  const runs = [task("a"), task("b"), task("c")];
  await tick();
  assert.deepEqual(started, ["a", "b"]);
  gates.b.open();
  await tick();
  assert.deepEqual(started, ["a", "b", "c"]);
  gates.a.open();
  gates.c.open();
  assert.deepEqual(await Promise.all(runs), ["a", "b", "c"]);
});

test("an abort while waiting leaves the queue without a slot", async () => {
  const limiter = new Limiter(1);
  const first = gate();
  const running = limiter.run(() => first.opened);
  const stop = new AbortController();
  const waiting = limiter.run(async () => "never", stop.signal);
  let thirdStarted = false;
  const third = limiter.run(async () => {
    thirdStarted = true;
  });

  stop.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(thirdStarted, false);
  first.open();
  await running;
  await third;
  assert.equal(thirdStarted, true);
  await assert.rejects(
    limiter.run(async () => "never", AbortSignal.abort()),
    { name: "AbortError" },
  );
});
