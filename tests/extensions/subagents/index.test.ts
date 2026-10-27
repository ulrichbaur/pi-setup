import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails } from "../../../extensions/subagents/types.ts";

// The extension reads its config and resolves the agent directory when it
// loads, so both are set before the import.
const agentDir = mkdtempSync(join(tmpdir(), "subagent-index-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
writeFileSync(
  join(agentDir, "subagents.json"),
  JSON.stringify({ maxConcurrency: 1 }),
);
mkdirSync(join(agentDir, "agents"));
writeFileSync(
  join(agentDir, "agents", "reviewer.md"),
  "---\nname: reviewer\ndescription: reviews diffs\ntools: read\n---\nReview.",
);
process.env.PI_CODING_AGENT_DIR = agentDir;
// The extension starts children with the script Pi runs from; point it at
// the fake RPC child.
process.argv[1] = join(import.meta.dirname, "fake-pi.ts");
const { default: subagents } = await import(
  "../../../extensions/subagents/index.ts"
);
const { renderDetails } = await import(
  "../../../extensions/subagents/render.ts"
);
const { RunRegistry } = await import("../../../extensions/subagents/runs.ts");
const { RESULT_MESSAGE_TYPE } = await import(
  "../../../extensions/subagents/types.ts"
);
const { fakeRun } = await import("./fake-run.ts");

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type Sent = { message: Record<string, unknown>; options: unknown };
type Handler = (event?: unknown, ctx?: unknown) => void;

function load() {
  const sent: Sent[] = [];
  const costs: unknown[] = [];
  const handlers: Record<string, Handler> = {};
  let tool: {
    description: string;
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
    events: {
      emit: (channel: string, data: unknown) => costs.push([channel, data]),
      on: () => () => {},
    },
    // Pi runs every handler of an event in registration order.
    on: (event: string, handler: Handler) => {
      const previous = handlers[event];
      handlers[event] = previous
        ? (data, ctx) => {
            previous(data, ctx);
            handler(data, ctx);
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
    hasUI: false,
    ui: {},
  };
  const run = (params: Record<string, unknown>) =>
    tool.execute("call", params, undefined, undefined, ctx);
  return {
    run,
    sent,
    arrived,
    handlers,
    registry,
    costs,
    description: () => tool.description,
  };
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
      cwd: "/nonexistent-project",
      isProjectTrusted: () => true,
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
    cwd: "/nonexistent-project",
    isProjectTrusted: () => true,
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

test("project agents load in trusted projects and override by name", () => {
  const project = mkdtempSync(join(tmpdir(), "subagent-project-"));
  try {
    mkdirSync(join(project, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "agents", "scout.md"),
      "---\nname: scout\ndescription: knows this repo\ntools: read\n---\nRepo notes.",
    );
    const start = (trusted: boolean) => {
      const loaded = load();
      const notices: string[] = [];
      loaded.handlers.session_start(
        {},
        {
          cwd: project,
          isProjectTrusted: () => trusted,
          sessionManager: { getBranch: () => [] },
          ui: { notify: (message: string) => notices.push(message) },
        },
      );
      return { description: loaded.description(), notices };
    };

    const untrusted = start(false);
    assert.match(untrusted.description, /reviewer \[user\] \(reviews diffs\)/);
    assert.doesNotMatch(untrusted.description, /knows this repo/);
    assert.match(untrusted.notices.join("\n"), /not trusted/);

    const trusted = start(true);
    assert.match(trusted.description, /scout \[project\] \(knows this repo\)/);
    assert.match(trusted.description, /worker \(/);
    assert.deepEqual(trusted.notices, []);

    writeFileSync(join(project, ".pi", "agents", "bad.md"), "no frontmatter");
    const broken = start(true);
    assert.match(
      broken.notices.join("\n"),
      /Project agents were not loaded: .*bad\.md/,
    );
    assert.doesNotMatch(broken.description, /knows this repo/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
