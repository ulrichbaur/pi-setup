import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { sessionRows } from "../../../../extensions/background-work/subagents/session-view.ts";
import type { SubagentDetails } from "../../../../extensions/background-work/subagents/types.ts";

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
const { registerSubagents: subagents } = await import(
  "../../../../extensions/background-work/subagents/register.ts"
);
const { renderDetails } = await import(
  "../../../../extensions/background-work/subagents/render.ts"
);
const { RunRegistry } = await import(
  "../../../../extensions/background-work/subagents/runs.ts"
);
const { RESULT_MESSAGE_TYPE } = await import(
  "../../../../extensions/background-work/subagents/types.ts"
);
const { fakeRun } = await import("./fake-run.ts");
const { loadAgents } = await import(
  "../../../../extensions/background-work/subagents/agents.ts"
);
const { parseSubagentConfig } = await import(
  "../../../../extensions/background-work/subagents/config.ts"
);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type Sent = { message: Record<string, unknown>; options: unknown };
type Handler = (event?: unknown, ctx?: unknown) => void;
type Command = {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: unknown;
};

function load() {
  const sent: Sent[] = [];
  const costs: unknown[] = [];
  const handlers: Record<string, Handler> = {};
  const commands: Record<string, Command> = {};
  let tool: {
    description: string;
    execute: (...args: unknown[]) => Promise<{
      content: Array<{ text: string }>;
      details: SubagentDetails;
    }>;
  };
  let peek: (params: { runId?: string; session?: string }) => Promise<{
    details: Array<{
      runId: string;
      status: string;
      elapsedMs: number;
      error?: string;
      result?: string;
    }>;
  }>;
  let halt: (params: { runId: string }) => Promise<{
    content: Array<{ text: string }>;
    details: { runId: string; status: string };
  }>;
  let delivered = () => {};
  const arrived = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const pi = {
    registerTool: (definition: typeof tool & { name: string }) => {
      if (definition.name === "subagent_status") {
        peek = (params) =>
          definition.execute("status", params) as unknown as ReturnType<
            typeof peek
          >;
      } else if (definition.name === "subagent_stop") {
        halt = (params) =>
          definition.execute("stop", params) as unknown as ReturnType<
            typeof halt
          >;
      } else {
        tool = definition;
      }
    },
    registerCommand: (name: string, command: Command) => {
      commands[name] = command;
    },
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
    peek: (params: { runId?: string; session?: string } = {}) => peek(params),
    halt: (params: { runId: string }) => halt(params),
    sent,
    arrived,
    handlers,
    commands,
    registry,
    costs,
    description: () => tool.description,
  };
}

test("malformed own config fails at load with its path and stays unchanged", () => {
  const path = join(agentDir, "subagents.json");
  const malformed = "{ broken JSON";
  writeFileSync(path, malformed);
  try {
    assert.throws(() => load(), { message: `${path}: invalid JSON` });
    assert.equal(readFileSync(path, "utf8"), malformed);
  } finally {
    writeFileSync(path, JSON.stringify({ maxConcurrency: 1 }));
  }
});

test("/agents rejects removed navigation actions and has no completions", async () => {
  const { commands } = load();
  const notices: string[] = [];
  const ctx = { ui: { notify: (message: string) => notices.push(message) } };
  assert.equal(commands.agents.getArgumentCompletions, undefined);
  await commands.agents.handler("open scout-12345678", ctx);
  await commands.agents.handler("back", ctx);
  assert.deepEqual(notices, ["Usage: /agents", "Usage: /agents"]);
});

test("a background run returns at once and delivers its result later", async () => {
  const { run, sent, arrived, peek } = load();
  assert.deepEqual((await peek()).details, []);
  const started = await run({
    agent: "scout",
    task: "look around",
    background: true,
  });
  assert.equal(started.details.background, true);
  assert.equal(started.details.results[0].progress.status, "pending");
  assert.match(started.content[0].text, /^Started in the background: scout-/);
  const runId = started.details.results[0].runId;
  assert.ok(runId);
  assert.match(started.content[0].text, new RegExp(runId));
  const status = (await peek({ runId })).details[0];
  assert.equal(status.runId, runId);
  const sessionId = started.details.results[0].sessionId as string;
  const bySession = (await peek({ session: sessionId })).details;
  assert.deepEqual(
    bySession.map((item) => item.runId),
    [runId],
  );
  assert.match(status.status, /^(pending|running)$/);
  assert.ok(status.elapsedMs >= 0);
  await assert.rejects(
    peek({ runId: "unknown" }),
    /Unknown background subagent run/,
  );
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
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
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
  assert.equal(details.results[0].runId, runId);
  assert.equal((await peek({ runId })).details[0].result, "line same line");
  assert.equal(sent.length, 1);
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
  await until(() =>
    registry.list().every((run) => run.result.progress.status === "failed"),
  );
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
    await until(() => first.result.live !== undefined);

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
    await until(() => second.result.live !== undefined);
    registry.stop(second);
    await foreground;
    const firstRunning = statuses.find((pair) => pair.endsWith("/running"));
    assert.equal(firstRunning, "failed/running");
    assert.equal(second.result.progress.error, "Stopped by the user");
  } finally {
    // A failed assertion must not leave hanging children behind.
    for (const run of registry.list()) registry.stop(run);
    await until(() =>
      registry
        .list()
        .every(
          (run) =>
            run.result.progress.status !== "running" &&
            run.result.progress.status !== "pending",
        ),
    );
    delete process.env.FAKE_PI_MODE;
  }
});

test("the parent stops queued and running background runs without a new turn", {
  timeout: 8_000,
}, async () => {
  process.env.FAKE_PI_MODE = "hang";
  const { run, registry, halt, sent } = load();
  try {
    const started = await run({
      tasks: [
        { agent: "scout", task: "first" },
        { agent: "scout", task: "second" },
      ],
      background: true,
    });
    const [first, second] = started.details.results.map(
      (result) => result.runId as string,
    );
    const live = registry.list().find((item) => item.result.runId === first);
    await until(() => live?.result.live !== undefined);

    // maxConcurrency is 1, so the second run waits for a slot.
    const queued = await halt({ runId: second });
    assert.equal(queued.details.status, "failed");
    assert.match(queued.content[0].text, /^Stopped background subagent scout/);
    const running = await halt({ runId: first });
    assert.equal(running.details.status, "failed");
    await until(() => sent.length === 2);
    for (const { message, options } of sent) {
      assert.deepEqual(options, { triggerTurn: false, deliverAs: "steer" });
      const [result] = (message.details as SubagentDetails).results;
      assert.equal(result.progress.error, "Stopped by the parent agent");
    }

    const again = await halt({ runId: first });
    assert.match(again.content[0].text, /had already ended: failed\.$/);
    await assert.rejects(
      halt({ runId: "unknown" }),
      /Unknown background subagent run: unknown/,
    );
  } finally {
    for (const item of registry.list()) registry.stop(item);
    delete process.env.FAKE_PI_MODE;
  }
});

test("a user stop delivers the result without starting a turn", async () => {
  process.env.FAKE_PI_MODE = "hang";
  const { run, registry, sent } = load();
  try {
    await run({ agent: "scout", task: "look around", background: true });
    const [live] = registry.list();
    await until(() => live.result.live !== undefined);
    registry.stop(live);
    await until(() => sent.length === 1);
    assert.deepEqual(sent[0].options, {
      triggerTurn: false,
      deliverAs: "steer",
    });
    const [result] = (sent[0].message.details as SubagentDetails).results;
    assert.equal(result.progress.error, "Stopped by the user");
  } finally {
    delete process.env.FAKE_PI_MODE;
  }
});

test("parallel background runs notify independently and get a full runtime after queuing", {
  timeout: 8_000,
}, async () => {
  process.env.FAKE_PI_MODE = "hang";
  const { run, registry, peek, sent, arrived, handlers } = load();
  const footer: Array<string | undefined> = [];
  handlers.session_start(
    {},
    {
      mode: "tui",
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: () => {},
        setStatus: (key: string, text?: string) => {
          assert.equal(key, "subagents");
          footer.push(text);
        },
      },
    },
  );
  try {
    const started = await run({
      background: true,
      timeoutMs: 40,
      tasks: [
        { agent: "scout", task: "unlimited", timeoutMs: 0 },
        { agent: "scout", task: "limited" },
      ],
    });
    const [first, second] = started.details.results;
    assert.ok(first.runId && second.runId && first.runId !== second.runId);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(
      (await peek()).details.map((entry) => entry.status),
      ["pending", "running"],
    );
    assert.equal(sent.length, 0);
    assert.equal(footer.at(-1), "Subagents: 1 running · 1 queued");

    registry.stop(registry.active(first.sessionId as string)!);
    await arrived;
    assert.equal(
      (sent[0].message.details as SubagentDetails).results[0].runId,
      first.runId,
    );
    assert.equal(
      (await peek({ runId: second.runId })).details[0].status,
      "running",
    );
    await until(() => sent.length === 2);
    const final = (await peek({ runId: second.runId })).details[0];
    assert.equal(final.status, "timed_out");
    assert.match(final.error ?? "", /40 ms runtime limit/);
    assert.match(String(sent[1].message.content), /Timed out/);
    assert.equal(footer.at(-1), undefined);
  } finally {
    handlers.session_shutdown();
    await until(() =>
      registry
        .list()
        .every(
          ({ result }) =>
            !["running", "pending"].includes(result.progress.status),
        ),
    );
    delete process.env.FAKE_PI_MODE;
  }
});

test("a timeout delivers captured streaming text as partial output", {
  timeout: 8_000,
}, async () => {
  process.env.FAKE_PI_MODE = "partial";
  const { run, arrived, sent } = load();
  try {
    await run({
      agent: "scout",
      task: "write slowly",
      background: true,
      timeoutMs: 600,
    });
    await arrived;
    assert.match(
      String(sent[0].message.content),
      /Timed out: [^\n]+\n\nPartial output:\nUnfinished message:\nunfinished answer\n/,
    );
    assert.deepEqual(sent[0].options, {
      triggerTurn: true,
      deliverAs: "steer",
    });
    assert.equal(sent.length, 1);
  } finally {
    delete process.env.FAKE_PI_MODE;
  }
});

test("a timeout keeps the last finished message before the unfinished one", {
  timeout: 8_000,
}, async () => {
  process.env.FAKE_PI_MODE = "partial-after-message";
  const { run, arrived, sent } = load();
  try {
    await run({
      agent: "scout",
      task: "write slowly",
      background: true,
      timeoutMs: 600,
    });
    await arrived;
    const content = String(sent[0].message.content);
    assert.match(
      content,
      /Partial output:\nfirst finding\n\nUnfinished message:\nunfinished answer\n/,
    );
    assert.equal(content.split("unfinished answer").length, 2);
    const [result] = (sent[0].message.details as SubagentDetails).results;
    assert.equal(result.progress.status, "timed_out");
  } finally {
    delete process.env.FAKE_PI_MODE;
  }
});

test("a settled run keeps its result if cleanup outlasts the timeout", {
  timeout: 8_000,
}, async () => {
  process.env.FAKE_PI_MODE = "linger";
  const { run, arrived, sent, peek, handlers } = load();
  try {
    const started = await run({
      agent: "scout",
      task: "finish before cleanup",
      background: true,
      timeoutMs: 1_500,
    });
    const { runId } = started.details.results[0];
    await arrived;
    const [finished] = (await peek({ runId })).details;
    assert.ok(finished.elapsedMs > 1_500);
    assert.equal(finished.status, "completed");
    assert.equal(sent.length, 1);
  } finally {
    handlers.session_shutdown();
    delete process.env.FAKE_PI_MODE;
  }
});

test("timeouts are validated and rejected for foreground runs", async () => {
  const { run, registry } = load();
  const request = { agent: "scout", task: "work" };
  await assert.rejects(
    run({ ...request, timeoutMs: 10 }),
    /requires background/,
  );
  await assert.rejects(
    run({ tasks: [{ ...request, timeoutMs: 10 }] }),
    /requires background/,
  );
  for (const timeoutMs of [-1, 0.5, 2_147_483_648]) {
    await assert.rejects(
      run({ ...request, background: true, timeoutMs }),
      /must be an integer/,
    );
  }
  assert.deepEqual(registry.list(), []);
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

test("a session start reports interrupted launches once, without a turn", async () => {
  const sessionId = "scout-0000abcd";
  const sessions = join(agentDir, "subagents", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `2026-01-01_${sessionId}.jsonl`), "");
  const launch = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "subagent",
      details: {
        mode: "single",
        background: true,
        results: [{ ...fakeRun(sessionId, "pending").result, runId: "run-1" }],
      },
    },
  };
  const start = (branch: unknown[]) => {
    const { handlers, sent } = load();
    handlers.session_start(
      {},
      {
        sessionManager: { getBranch: () => branch },
        ui: { notify: () => {} },
      },
    );
    return sent;
  };

  const sent = start([launch]);
  // The message follows after the handler returns.
  assert.equal(sent.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  const [{ message, options }] = sent;
  assert.deepEqual(options, { triggerTurn: false, deliverAs: "steer" });
  assert.equal(message.customType, RESULT_MESSAGE_TYPE);
  assert.match(
    String(message.content),
    /^Background subagent interrupted:\n\nInterrupted: .*Its subagent session scout-0000abcd is saved\./,
  );
  assert.match(String(message.content), /Run ID: run-1/);
  const details = message.details as SubagentDetails;
  assert.equal(details.interrupted, true);

  // Once the message is saved, the launch has its result.
  const again = start([
    launch,
    { type: "custom_message", customType: RESULT_MESSAGE_TYPE, details },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(again.length, 0);
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
  saved.messageStart = 0;
  saved.messageEnd = 3;
  saved.question = "Which color?";
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

  // Continuing the same session remains a separate cost event source.
  const running = fakeRun("scout-00000001");
  running.result.messageStart = 3;
  running.result.usage.cost = 0.001;
  registry.add(running);
  near(lastCost(), 0.021);
  const emitted = costs.length;
  const rows = sessionRows(registry.list());
  assert.equal(rows.length, 1);
  near(rows[0].result.usage.cost, 0.021);
  assert.equal(costs.length, emitted);
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

test("worker config fails even when a user agent file exists", () => {
  const config = parseSubagentConfig({
    agents: { worker: { models: ["provider/model"] } },
  });
  assert.throws(
    () => loadAgents(config),
    /agents\.worker is not a built-in agent/,
  );
  const workerFile = join(agentDir, "agents", "worker.md");
  try {
    writeFileSync(
      workerFile,
      "---\nname: worker\ndescription: custom worker\ntools: read, safe_bash\n---\nWork.",
    );
    assert.throws(
      () => loadAgents(config),
      /agents\.worker is not a built-in agent/,
    );
  } finally {
    rmSync(workerFile);
  }
});

test("external agent files never load, override, or require trust", () => {
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
    assert.doesNotMatch(untrusted.description, /reviewer/);
    assert.doesNotMatch(untrusted.description, /knows this repo/);
    assert.deepEqual(untrusted.notices, []);

    const trusted = start(true);
    assert.match(trusted.description, /scout \(/);
    assert.doesNotMatch(trusted.description, /knows this repo|reviewer/);
    assert.match(trusted.description, /analyst \(/);
    assert.match(trusted.description, /researcher \(/);
    assert.doesNotMatch(trusted.description, /worker \(/);
    assert.deepEqual(trusted.notices, []);

    writeFileSync(join(project, ".pi", "agents", "bad.md"), "no frontmatter");
    const broken = start(true);
    assert.deepEqual(broken.notices, []);
    assert.doesNotMatch(broken.description, /knows this repo/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
