import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  QuotaAdapter,
  QuotaStatus,
} from "../../../extensions/pi-statusline/quota/types.ts";
import {
  createStatuslineRuntime,
  createStatusSnapshot,
} from "../../../extensions/pi-statusline/statusline.ts";

const quota = (overrides: Partial<QuotaStatus> = {}): QuotaStatus => ({
  provider: "codex",
  windows: [{ label: "5h", percentRemaining: 75, precision: 0 }],
  fetchedAt: new Date(),
  ...overrides,
});

test("snapshot derives context, token totals, cost, and latest cache-hit rate", () => {
  const assistant = (
    cost: number,
    input: number,
    cacheRead: number,
    cacheWrite = 0,
  ) => ({
    type: "message",
    message: {
      role: "assistant",
      usage: { cost: { total: cost }, input, cacheRead, cacheWrite },
    },
  });
  const ctx = {
    model: { provider: "codex", id: "gpt", contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 10_000 }),
    sessionManager: {
      getBranch: () => [
        assistant(0.1, 80, 20),
        { type: "message", message: { role: "user" } },
        assistant(0.2, 25, 75),
      ],
    },
  } as unknown as ExtensionContext;

  const snapshot = createStatusSnapshot(
    { getThinkingLevel: () => "high" } as Pick<
      ExtensionAPI,
      "getThinkingLevel"
    >,
    ctx,
  );
  assert.deepEqual(snapshot.context, { tokens: 10_000, maxTokens: 200_000 });
  assert.equal(snapshot.inputTokens, 105);
  assert.equal(snapshot.outputTokens, 0);
  assert.ok(Math.abs((snapshot.sessionCost ?? 0) - 0.3) < Number.EPSILON);
  assert.equal(snapshot.cacheHitRate, 75);
});

test("statusline installs one footer, rerenders, and restores it on shutdown", async () => {
  const footerCalls: unknown[] = [];
  let renders = 0;
  const ui = {
    setFooter(value: unknown) {
      footerCalls.push(value);
    },
  };
  const ctx = makeContext("tui", ui);
  const runtime = createStatuslineRuntime(
    { getThinkingLevel: () => "off" } as ExtensionAPI,
    [],
  );

  await runtime.update(ctx);
  await runtime.update(ctx);
  assert.equal(footerCalls.length, 1);

  const factory = footerCalls[0] as (
    tui: unknown,
    theme: unknown,
    data: unknown,
  ) => { render(width: number): string[] };
  const component = factory(
    { requestRender: () => renders++ },
    { fg: (_color: string, text: string) => text },
    { getGitBranch: () => "main", onBranchChange: () => () => {} },
  );
  assert.match(component.render(100)[0], /pi-temp-extensions \(main\)/);

  await runtime.update(ctx);
  assert.equal(renders, 1);
  runtime.dispose(ctx);
  assert.equal(footerCalls.at(-1), undefined);
});

test("statusline installs its footer before quota I/O completes", async () => {
  const footerCalls: unknown[] = [];
  let resolveQuota!: (status: QuotaStatus) => void;
  const pendingQuota = new Promise<QuotaStatus>((resolve) => {
    resolveQuota = resolve;
  });
  const adapter: QuotaAdapter = {
    provider: "codex",
    getQuota: () => pendingQuota,
  };
  const runtime = createStatuslineRuntime(
    { getThinkingLevel: () => "off" } as ExtensionAPI,
    [adapter],
  );

  const update = runtime.update(
    makeContext("tui", { setFooter: (value) => footerCalls.push(value) }),
  );
  assert.equal(footerCalls.length, 1);

  resolveQuota(quota());
  await update;
});

test("statusline is inert outside TUI mode", async () => {
  let footerCalls = 0;
  let quotaCalls = 0;
  const adapter: QuotaAdapter = {
    provider: "codex",
    async getQuota() {
      quotaCalls++;
      return quota();
    },
  };
  const runtime = createStatuslineRuntime(
    { getThinkingLevel: () => "off" } as ExtensionAPI,
    [adapter],
  );
  await runtime.update(makeContext("rpc", { setFooter: () => footerCalls++ }));
  assert.equal(footerCalls, 0);
  assert.equal(quotaCalls, 0);
});

function makeContext(
  mode: "tui" | "rpc",
  ui: { setFooter(value: unknown): void },
): ExtensionContext {
  return {
    mode,
    hasUI: true,
    ui,
    cwd: "/home/ub/pi-temp-extensions",
    model: { provider: "codex", id: "gpt", contextWindow: 100_000 },
    getContextUsage: () => undefined,
    sessionManager: { getBranch: () => [], getSessionName: () => undefined },
  } as unknown as ExtensionContext;
}
