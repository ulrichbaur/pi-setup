import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The features resolve the agent directory when they load, so it is set
// before the import.
const agentDir = mkdtempSync(join(tmpdir(), "background-work-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: backgroundWork } = await import(
  "../../../extensions/background-work/index.ts"
);

type Handler = (event: unknown, ctx: unknown) => unknown;

async function load() {
  const tools: string[] = [];
  const starts: Handler[] = [];
  const commands: Record<string, (args: string, ctx: unknown) => unknown> = {};
  const pi = {
    registerTool: ({ name }: { name: string }) => tools.push(name),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: unknown) => unknown },
    ) => {
      commands[name] = command.handler;
    },
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    getSettings: () => ({}),
    events: { emit: () => {}, on: () => () => {} },
    on: (event: string, handler: Handler) => {
      if (event === "session_start") starts.push(handler);
    },
  } as unknown as ExtensionAPI;
  await backgroundWork(pi);
  const notices: string[] = [];
  const ctx = {
    mode: "print",
    sessionManager: {
      getSessionId: () => "00112233-4455-6677-8899-aabbccddeeff",
      getBranch: () => [],
    },
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
    },
  };
  for (const handler of starts) await handler({}, ctx);
  return { tools, notices, commands };
}

test("a broken subagent config leaves the shell tasks working", async () => {
  const config = join(agentDir, "subagents.json");
  writeFileSync(config, "{ broken");
  const { tools, notices } = await load();
  assert.deepEqual(tools, ["task_start", "task_stop", "task_status"]);
  assert.deepEqual(notices, [`Subagents not loaded: ${config}: invalid JSON`]);
});

test("both features register when nothing fails", async () => {
  writeFileSync(join(agentDir, "subagents.json"), "{}");
  const { tools, notices } = await load();
  assert.deepEqual(tools.sort(), [
    "subagent",
    "subagent_status",
    "subagent_stop",
    "task_start",
    "task_status",
    "task_stop",
  ]);
  assert.deepEqual(notices, []);
});

test("/tasks opens when the job records cannot be read", async () => {
  writeFileSync(join(agentDir, "subagents.json"), "{}");
  const sessionId = "my-run";
  // A file where the session's job folder belongs makes reading it fail.
  mkdirSync(join(agentDir, "background-tasks"), { recursive: true });
  writeFileSync(join(agentDir, "background-tasks", sessionId), "");
  const { commands } = await load();
  const notices: string[] = [];
  let screen = "";
  await commands.tasks("", {
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message: string) => notices.push(message),
      custom: async (
        factory: (...args: unknown[]) => { render(width: number): string[] },
      ) => {
        const view = factory(
          { terminal: { rows: 30 }, requestRender: () => {} },
          {
            fg: (_color: string, text: string) => text,
            bold: (t: string) => t,
          },
          { matches: () => false },
          () => {},
        );
        screen = view.render(100).join("\n");
      },
    },
  });
  assert.deepEqual(notices, []);
  assert.match(screen, /Shell tasks unavailable: Error: ENOTDIR/);
});
