import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import subagents from "../../../extensions/subagents/index.ts";
import { renderDetails } from "../../../extensions/subagents/render.ts";
import { RunRegistry } from "../../../extensions/subagents/runs.ts";
import {
  RESULT_MESSAGE_TYPE,
  type SubagentDetails,
} from "../../../extensions/subagents/types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

// The extension starts children with the script Pi runs from; point it at
// the fake RPC child.
process.argv[1] = join(import.meta.dirname, "fake-pi.ts");

type Sent = { message: Record<string, unknown>; options: unknown };

function fakeUI() {
  const calls: string[] = [];
  const ui = {
    notify: (message: string) => calls.push(`notify: ${message}`),
    confirm: async () => {
      calls.push("confirm");
      return true;
    },
    select: async () => undefined,
  };
  return { ui, calls };
}

function load(ui?: Record<string, unknown>) {
  const sent: Sent[] = [];
  const handlers: Record<string, () => void> = {};
  let tool: {
    execute: (...args: unknown[]) => Promise<{
      content: Array<{ text: string }>;
      details: SubagentDetails;
    }>;
  };
  let delivered = () => {};
  const arrived = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const pi = {
    registerTool: (definition: typeof tool) => {
      tool = definition;
    },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    events: { emit: () => {}, on: () => () => {} },
    // Pi runs every handler of an event in registration order.
    on: (event: string, handler: () => void) => {
      const previous = handlers[event];
      handlers[event] = previous
        ? () => {
            previous();
            handler();
          }
        : handler;
    },
    sendMessage: (message: Record<string, unknown>, options: unknown) => {
      sent.push({ message, options });
      delivered();
    },
  } as unknown as ExtensionAPI;
  const registry = new RunRegistry();
  subagents(pi, registry);
  const ctx = {
    cwd: process.cwd(),
    modelRegistry: { getAvailable: () => [] },
    hasUI: ui !== undefined,
    ui: ui ?? {},
  };
  const run = (params: Record<string, unknown>) =>
    tool.execute("call", params, undefined, undefined, ctx);
  return { run, sent, arrived, handlers, registry };
}

test("a background run returns at once and delivers its result later", async () => {
  const { run, sent, arrived } = load();
  const started = await run({
    agent: "scout",
    task: "look around",
    background: true,
  });
  assert.equal(started.details.background, true);
  assert.equal(started.details.results[0].progress.status, "pending");
  assert.match(started.content[0].text, /^Started in the background: scout-/);
  assert.equal(sent.length, 0);
  const row = renderDetails(started.details, false, theme, {
    invalidate: () => {},
    hideThinking: false,
  })
    .render(80)
    .map((line) => line.trim());
  assert.match(row[0], /^⇢ scout scout-[0-9a-f]{8} started in the background$/);
  assert.deepEqual(row.slice(1), [
    "Task: look around",
    "Follow it with /agents.",
  ]);

  await arrived;
  const [{ message, options }] = sent;
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(message.customType, RESULT_MESSAGE_TYPE);
  assert.equal(message.display, true);
  assert.ok(
    String(message.content).startsWith(
      "Background subagent result:\n\nline same line",
    ),
  );
  const details = message.details as SubagentDetails;
  assert.equal(details.results[0].progress.status, "completed");
  assert.equal(details.results[0].live, undefined);
});

test("a foreground run waits for the child and returns its output", async () => {
  const { run, sent } = load();
  const result = await run({ agent: "scout", task: "look around" });
  assert.equal(result.details.background, undefined);
  assert.ok(result.content[0].text.startsWith("line same line"));
  assert.equal(sent.length, 0);
});

test("results of a shut-down session are never delivered", async () => {
  const { run, sent, handlers, registry } = load();
  await run({ agent: "scout", task: "look around", background: true });
  handlers.session_shutdown();
  assert.equal(await registry.stopAll(), true);
  // Delivery follows in the same promise chain, before the next macrotask.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
});

test("a background question waits in /agents instead of a dialog", async () => {
  const { ui, calls } = fakeUI();
  const { run, sent, arrived, registry } = load(ui);
  await run({ agent: "scout", task: "look around", background: true });
  while (!registry.list()[0]?.pendingDialogs.length) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(
    calls.join("\n"),
    /notify: scout-\w+ is waiting for your answer/,
  );
  assert.equal(calls.includes("confirm"), false);

  registry.list()[0].pendingDialogs[0].answer({ confirmed: true });
  await arrived;
  assert.equal(sent.length, 1);
});

test("a foreground question still opens a dialog", async () => {
  const { ui, calls } = fakeUI();
  const { run } = load(ui);
  await run({ agent: "scout", task: "look around" });
  assert.deepEqual(calls, ["confirm"]);
});

test("deliverEach sends each background result when its run ends", async () => {
  const { run, sent } = load();
  const started = await run({
    background: true,
    deliverEach: true,
    tasks: [
      { agent: "scout", task: "first" },
      { agent: "scout", task: "second" },
    ],
  });
  assert.match(
    started.content[0].text,
    /Each result arrives as its own message/,
  );
  while (sent.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const headings = sent
    .map(({ message }) => String(message.content).split(":")[0])
    .sort();
  assert.deepEqual(headings, [
    "Background subagent result (scout, task 1 of 2)",
    "Background subagent result (scout, task 2 of 2)",
  ]);
  for (const { message } of sent) {
    const details = message.details as SubagentDetails;
    assert.equal(details.mode, "single");
    assert.equal(details.results.length, 1);
  }
});

test("a shutdown cancels every pending per-task delivery", async () => {
  const { run, sent, handlers, registry } = load();
  await run({
    background: true,
    deliverEach: true,
    tasks: [
      { agent: "scout", task: "first" },
      { agent: "scout", task: "second" },
    ],
  });
  handlers.session_shutdown();
  assert.equal(await registry.stopAll(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0);
});
