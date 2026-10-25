import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The extension reads its config and resolves the agent directory when it
// loads, so both are set before the import.
const agentDir = mkdtempSync(join(tmpdir(), "subagent-session-runs-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
writeFileSync(
  join(agentDir, "subagents.json"),
  JSON.stringify({ maxConcurrency: 1 }),
);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.argv[1] = join(import.meta.dirname, "fake-pi.ts");
const { default: subagents, RESULT_MESSAGE_TYPE } = await import(
  "../../../extensions/subagents/index.ts"
);
const { RunRegistry } = await import("../../../extensions/subagents/runs.ts");
const { fakeRun } = await import("./fake-run.ts");

type Handler = (event: unknown, ctx: unknown) => void;

function load() {
  const registry = new RunRegistry();
  const handlers: Record<string, Handler> = {};
  const costs: unknown[] = [];
  let tool: {
    execute: (...args: unknown[]) => Promise<unknown>;
  };
  subagents(
    {
      registerTool: (definition: typeof tool) => {
        tool = definition;
      },
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      events: {
        emit: (channel: string, data: unknown) => costs.push([channel, data]),
        on: () => () => {},
      },
      on: (event: string, handler: Handler) => {
        handlers[event] = handler;
      },
      sendMessage: () => {},
    } as unknown as ExtensionAPI,
    registry,
  );
  const ctx = {
    cwd: process.cwd(),
    modelRegistry: { getAvailable: () => [] },
    hasUI: false,
    ui: {},
  };
  const run = (params: Record<string, unknown>) =>
    tool.execute("call", params, undefined, undefined, ctx);
  return { registry, handlers, run, costs };
}

const until = async (condition: () => boolean) => {
  while (!condition()) await new Promise((resolve) => setImmediate(resolve));
};

test("background and foreground runs share one concurrency limit", async () => {
  process.env.FAKE_PI_MODE = "hang";
  const { registry, run } = load();
  try {
    await run({ agent: "scout", task: "first", background: true });
    const first = registry.list()[0];
    await until(() => first.child !== undefined);

    const statuses: string[] = [];
    registry.subscribe(() => {
      const second = registry.list()[0];
      if (second !== first) {
        statuses.push(
          `${first.result.progress.status}/${second.result.progress.status}`,
        );
      }
    });
    const foreground = run({ agent: "scout", task: "second" });
    const second = registry.list()[0];
    await until(() => statuses.length > 0);
    assert.equal(second.result.progress.status, "pending");

    registry.stop(first);
    await until(() => second.child !== undefined);
    registry.stop(second);
    await foreground;
    const firstRunning = statuses.find((pair) => pair.endsWith("/running"));
    assert.equal(firstRunning, "failed/running");
    assert.equal(second.result.progress.error, "Stopped by the user");
  } finally {
    // A failed assertion must not leave hanging children behind.
    await registry.stopAll();
    delete process.env.FAKE_PI_MODE;
  }
});

test("a session start rebuilds the list from the saved results", () => {
  const { registry, handlers } = load();
  const saved = fakeRun("scout-00000001", "completed").result;
  handlers.session_start(
    {},
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolName: "subagent",
              details: { mode: "single", results: [saved] },
            },
          },
          {
            type: "custom_message",
            customType: RESULT_MESSAGE_TYPE,
            details: {
              mode: "single",
              results: [fakeRun("worker-00000002", "failed").result],
            },
          },
        ],
      },
      ui: { notify: () => {} },
    },
  );
  assert.deepEqual(
    registry.list().map((run) => run.result.sessionId),
    ["worker-00000002", "scout-00000001"],
  );
});

test("the subagent cost total covers saved and running runs", () => {
  const { registry, handlers, costs } = load();
  const lastCost = () => {
    const [channel, data] = costs.at(-1) as [string, { cost: number }];
    assert.equal(channel, "subagents:cost");
    return data.cost;
  };
  const near = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  const saved = fakeRun("scout-00000001", "completed").result;
  saved.usage.cost = 0.02;
  const delivered = fakeRun("worker-00000002", "completed").result;
  delivered.usage.cost = 0.005;
  const savedToolResult = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: { mode: "single", results: [saved] },
    },
  };
  const branch: unknown[] = [savedToolResult];
  const ctx = {
    sessionManager: { getBranch: () => branch },
    ui: { notify: () => {} },
  };
  handlers.session_start({}, ctx);
  near(lastCost(), 0.02);

  const running = fakeRun("scout-00000003");
  running.result.usage.cost = 0.001;
  registry.add(running);
  near(lastCost(), 0.021);
  const emitted = costs.length;
  registry.changed();
  assert.equal(costs.length, emitted);

  // A finished run still counts before Pi saves its result.
  running.result.progress.status = "completed";
  registry.changed();
  assert.equal(costs.length, emitted);
  handlers.message_end(
    {
      message: {
        role: "toolResult",
        toolName: "subagent",
        details: { mode: "single", results: [running.result] },
      },
    },
    ctx,
  );
  assert.equal(costs.length, emitted);

  // A delivered result counts once, saved or pending.
  const deliveredEntry = {
    type: "custom_message",
    customType: RESULT_MESSAGE_TYPE,
    details: { mode: "single", results: [delivered] },
  };
  branch.push(deliveredEntry);
  handlers.message_end(
    {
      message: {
        role: "custom",
        customType: RESULT_MESSAGE_TYPE,
        details: deliveredEntry.details,
      },
    },
    ctx,
  );
  near(lastCost(), 0.026);
});
