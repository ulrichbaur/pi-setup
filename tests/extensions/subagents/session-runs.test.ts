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
const { default: subagents } = await import(
  "../../../extensions/subagents/index.ts"
);
const { RunRegistry } = await import("../../../extensions/subagents/runs.ts");

type Handler = (event: unknown, ctx: unknown) => void;

function load() {
  const registry = new RunRegistry();
  const handlers: Record<string, Handler> = {};
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
  return { registry, handlers, run };
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
