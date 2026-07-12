import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadOpenCodeGoAuthCookie } from "../extensions/pi-statusline/auth.ts";
import {
  loadConfig,
  type StatuslineConfig,
  saveConfig,
} from "../extensions/pi-statusline/config.ts";
import {
  formatQuotaLine,
  formatStatusline,
} from "../extensions/pi-statusline/format.ts";
import { commitStatuslineChanges } from "../extensions/pi-statusline/menu.ts";
import { withQuotaCache } from "../extensions/pi-statusline/quota/cache.ts";
import type {
  QuotaAdapter,
  QuotaStatus,
} from "../extensions/pi-statusline/quota/types.ts";
import { createStatuslineRuntime } from "../extensions/pi-statusline/statusline.ts";

const stripAnsi = (value: string) =>
  value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
const quota = (overrides: Partial<QuotaStatus> = {}): QuotaStatus => ({
  provider: "codex",
  windows: [{ label: "5h", percentRemaining: 75, precision: 0 }],
  fetchedAt: new Date(),
  ...overrides,
});

test("formats the status summary from model, context, cost, and cache usage", () => {
  const line = stripAnsi(
    formatStatusline({
      provider: "anthropic",
      model: "models/claude-sonnet",
      thinkingLevel: "high",
      context: { tokens: 25_000, maxTokens: 100_000 },
      sessionCost: 1.2345,
      cacheHitRate: 80,
    }),
  );

  assert.equal(
    line,
    "anthropic/claude-sonnet (high) · 25.0%/100k · $1.234 CH80.0%",
  );
  assert.equal(
    stripAnsi(formatStatusline({ context: { tokens: 999 } })),
    "999",
  );
  assert.equal(formatStatusline({ sessionCost: 0 }), "");
});

test("formats quota windows, stale data, and errors", () => {
  const line = stripAnsi(
    formatQuotaLine({
      quota: quota({
        stale: true,
        windows: [
          { label: "5h", percentRemaining: 75, precision: 0 },
          { label: "7d", percentRemaining: 12.5, precision: 1 },
        ],
      }),
    }),
  );
  assert.equal(line, "5h: 25% | 7d: 87.5% (stale)");
  assert.equal(
    formatQuotaLine({
      quota: quota({ windows: [], error: "quota unavailable" }),
    }),
    "quota unavailable",
  );
  assert.equal(formatQuotaLine({ quota: quota({ windows: [] }) }), "");
});

test("quota cache reuses fresh values and deduplicates concurrent requests", async () => {
  let now = 1_000;
  let calls = 0;
  let release: ((status: QuotaStatus) => void) | undefined;
  const pending = new Promise<QuotaStatus>((resolve) => (release = resolve));
  const adapter: QuotaAdapter = {
    provider: "codex",
    getQuota: async () => {
      calls++;
      return pending;
    },
  };
  const cached = withQuotaCache(adapter, { now: () => now, ttlOkMs: 100 });

  const first = cached.getQuota({});
  const second = cached.getQuota({});
  assert.equal(calls, 1);
  release?.(quota());
  assert.equal(await first, await second);

  now = 1_050;
  await cached.getQuota({});
  assert.equal(calls, 1);
});

test("quota cache serves stale data after repeated failures and recovers", async () => {
  let now = 1;
  let fail = false;
  let calls = 0;
  const adapter: QuotaAdapter = {
    provider: "codex",
    async getQuota() {
      calls++;
      if (fail) throw new Error("offline");
      return quota();
    },
  };
  const cached = withQuotaCache(adapter, {
    now: () => now,
    ttlOkMs: 1,
    ttlRetryMs: 1,
    staleFailureLimit: 3,
  });

  await cached.getQuota({});
  fail = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    now += 2;
    const result = await cached.getQuota({});
    assert.equal(result?.stale, attempt === 3 ? true : undefined);
  }
  fail = false;
  now += 2;
  assert.equal((await cached.getQuota({}))?.stale, undefined);
  assert.equal(calls, 5);
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

test("saveConfig writes JSON, round-trips through loadConfig, and drops empty opencodeGo blocks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");

  const withWorkspace: StatuslineConfig = {
    quotas: { codex: false, opencodeGo: true },
    opencodeGo: { workspaceId: "ws-1" },
  };
  await saveConfig(withWorkspace, path);
  assert.deepEqual(await loadConfig(path), withWorkspace);

  // Clearing the workspaceId should also drop the now-empty opencodeGo block on disk.
  await saveConfig(
    { quotas: { codex: false, opencodeGo: true }, opencodeGo: {} },
    path,
  );
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.opencodeGo, undefined);
  // The on-disk representation omits the empty block, so loadConfig returns the same shape.
  assert.deepEqual(await loadConfig(path), {
    quotas: { codex: false, opencodeGo: true },
  });
});

test("commitStatuslineChanges leaves auth untouched when it was not changed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  const original = '{ "opencodeGo": { "authCookie": "old" } }\n';
  await writeFile(authPath, original);

  await commitStatuslineChanges({
    config: { quotas: { codex: true, opencodeGo: false } },
    authCookie: "replacement",
    authCookieChanged: false,
    configPath: join(dir, "config.json"),
    authPath,
  });
  assert.equal(await readFile(authPath, "utf8"), original);
});

test("commitStatuslineChanges writes to the paths in its menu state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-statusline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "custom-config.json");
  const authPath = join(dir, "custom-auth.json");
  const config: StatuslineConfig = {
    quotas: { codex: false, opencodeGo: true },
  };

  await commitStatuslineChanges({
    config,
    authCookie: "secret-cookie",
    authCookieChanged: true,
    configPath,
    authPath,
  });

  assert.deepEqual(await loadConfig(configPath), config);
  assert.equal(await loadOpenCodeGoAuthCookie(authPath), "secret-cookie");
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
