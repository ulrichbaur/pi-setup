import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDialogQueue,
  forwardDialog,
  forwardNotification,
  type ParentUI,
} from "../../../extensions/subagents/dialogs.ts";

type Call = { method: string; args: unknown[] };

function fakeUI(answers: Record<string, unknown> = {}): {
  ui: ParentUI;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answers[method];
    };
  const ui = {
    select: record("select"),
    confirm: record("confirm"),
    input: record("input"),
    editor: record("editor"),
    notify: (...args: unknown[]) => calls.push({ method: "notify", args }),
  } as unknown as ParentUI;
  return { ui, calls };
}

const live = new AbortController().signal;
// The queue starts each task on a later tick.
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("child dialogs reach the parent UI with the subagent's label", async () => {
  const { ui, calls } = fakeUI({
    select: "Allow",
    confirm: true,
    input: "main",
    editor: undefined,
  });
  const enqueue = createDialogQueue();
  const forward = (request: Record<string, unknown>) =>
    forwardDialog(enqueue, ui, request, "worker-0a1b2c3d", live);

  assert.deepEqual(
    await forward({ method: "select", title: "Pick", options: ["Allow", 3] }),
    { value: "Allow" },
  );
  assert.deepEqual(
    await forward({ method: "confirm", title: "Run?", message: "rm x" }),
    { confirmed: true },
  );
  assert.deepEqual(await forward({ method: "input", title: "Branch?" }), {
    value: "main",
  });
  assert.deepEqual(await forward({ method: "editor", title: "Edit" }), {
    cancelled: true,
  });
  assert.deepEqual(await forward({ method: "unknown" }), { cancelled: true });

  assert.deepEqual(calls[0], {
    method: "select",
    args: [
      "worker-0a1b2c3d: Pick",
      ["Allow"],
      { signal: live, timeout: undefined },
    ],
  });
  assert.equal(calls[1].args[1], "rm x");
});

test("dialogs from parallel subagents open one at a time", async () => {
  const enqueue = createDialogQueue();
  const order: string[] = [];
  let release = () => {};
  const first = enqueue(
    () =>
      new Promise<void>((resolve) => {
        order.push("first open");
        release = () => {
          order.push("first closed");
          resolve();
        };
      }),
  );
  const second = enqueue(async () => {
    order.push("second open");
  });
  await tick();
  assert.deepEqual(order, ["first open"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first open", "first closed", "second open"]);
});

test("a dialog the child gave up on is never shown", async () => {
  const { ui, calls } = fakeUI({ confirm: true });
  const aborted = AbortSignal.abort();
  assert.deepEqual(
    await forwardDialog(
      createDialogQueue(),
      ui,
      { method: "confirm" },
      "x",
      aborted,
    ),
    { cancelled: true },
  );

  let time = 0;
  const enqueue = createDialogQueue();
  let release = () => {};
  const blocker = enqueue(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const waiting = forwardDialog(
    enqueue,
    ui,
    { method: "confirm", timeout: 1_000 },
    "x",
    live,
    () => time,
  );
  time = 1_000;
  await tick();
  release();
  await blocker;
  assert.deepEqual(await waiting, { cancelled: true });
  assert.equal(calls.length, 0);
});

test("the remaining timeout carries over to the parent dialog", async () => {
  const { ui, calls } = fakeUI({ confirm: false });
  let time = 0;
  const enqueue = createDialogQueue();
  let release = () => {};
  const blocker = enqueue(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const waiting = forwardDialog(
    enqueue,
    ui,
    { method: "confirm", timeout: 1_000 },
    "x",
    live,
    () => time,
  );
  time = 400;
  await tick();
  release();
  await blocker;
  assert.deepEqual(await waiting, { confirmed: false });
  assert.deepEqual(calls[0].args[2], { signal: live, timeout: 600 });
});

test("child notifications keep their type and gain the label", () => {
  const { ui, calls } = fakeUI();
  forwardNotification(ui, { message: "done", notifyType: "warning" }, "s-1");
  forwardNotification(ui, { message: "hi", notifyType: "odd" }, "s-1");
  assert.deepEqual(calls, [
    { method: "notify", args: ["s-1: done", "warning"] },
    { method: "notify", args: ["s-1: hi", "info"] },
  ]);
});
