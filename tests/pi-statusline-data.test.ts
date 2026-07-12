import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadOpenCodeGoAuthCookie,
  saveOpenCodeGoAuthCookie,
} from "../extensions/pi-statusline/auth.ts";
import { normalizeCodexUsage } from "../extensions/pi-statusline/quota/codex.ts";
import {
  createOpenCodeGoQuotaAdapter,
  parseOpenCodeGoHtml,
} from "../extensions/pi-statusline/quota/opencode-go.ts";
import { createStatusSnapshot } from "../extensions/pi-statusline/statusline.ts";

test("loads the OpenCode Go cookie only from its dedicated auth file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-statusline-auth-"));
  const authFile = join(directory, "pi-statusline.auth.json");
  try {
    await writeFile(
      authFile,
      JSON.stringify({ opencodeGo: { authCookie: " cookie-value " } }),
    );
    assert.equal(await loadOpenCodeGoAuthCookie(authFile), "cookie-value");
    assert.equal(
      await loadOpenCodeGoAuthCookie(join(directory, "missing.json")),
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saves the OpenCode Go cookie without replacing other auth fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-statusline-auth-"));
  const authFile = join(directory, "pi-statusline.auth.json");
  try {
    await writeFile(
      authFile,
      JSON.stringify({
        other: { value: true },
        opencodeGo: { future: "keep" },
      }),
    );
    await saveOpenCodeGoAuthCookie(" cookie-value ", authFile);
    assert.deepEqual(JSON.parse(await readFile(authFile, "utf8")), {
      other: { value: true },
      opencodeGo: { future: "keep", authCookie: "cookie-value" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot derives context, assistant cost, and latest cache-hit rate", () => {
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
  assert.ok(Math.abs((snapshot.sessionCost ?? 0) - 0.3) < Number.EPSILON);
  assert.equal(snapshot.cacheHitRate, 75);
});

test("Codex normalization maps windows, clamps usage, and accepts reset formats", () => {
  const before = Date.now();
  const result = normalizeCodexUsage({
    rate_limit: {
      primary_window: { used_percent: -5, reset_after_seconds: 60 },
      secondary_window: {
        used_percent: 120,
        reset_at: Math.floor((before + 120_000) / 1000),
      },
    },
  });
  assert.deepEqual(
    result?.windows.map(({ label, percentRemaining }) => ({
      label,
      percentRemaining,
    })),
    [
      { label: "5h", percentRemaining: 100 },
      { label: "7d", percentRemaining: 0 },
    ],
  );
  assert.ok((result?.windows[0].resetsAt?.getTime() ?? 0) >= before + 59_000);
  assert.ok((result?.windows[1].resetsAt?.getTime() ?? 0) >= before + 118_000);
  assert.equal(
    normalizeCodexUsage({
      rate_limit: { primary_window: { used_percent: null } },
    }),
    undefined,
  );
});

test("Codex labels model-specific windows by their actual duration", () => {
  const result = normalizeCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 0,
        limit_window_seconds: 7 * 24 * 60 * 60,
      },
    },
  });
  assert.equal(result?.windows[0].label, "7d");
});

test("OpenCode Go parses SolidJS windows", () => {
  const now = 1_000_000;
  const html = [
    "rollingUsage:$R[1]={usagePercent:25.5,resetInSec:60}",
    "weeklyUsage:$R[2]={usagePercent:50,resetInSec:120}",
    "monthlyUsage:$R[3]={usagePercent:90,resetInSec:180}",
  ].join("");
  const windows = parseOpenCodeGoHtml(html, now);
  assert.deepEqual(
    windows.map(({ label, percentRemaining, resetsAt }) => ({
      label,
      percentRemaining,
      reset: resetsAt?.getTime(),
    })),
    [
      { label: "5h", percentRemaining: 74.5, reset: now + 60_000 },
      { label: "7d", percentRemaining: 50, reset: now + 120_000 },
      { label: "30d", percentRemaining: 10, reset: now + 180_000 },
    ],
  );
});

test("OpenCode Go parses semantic HTML by label and tolerates partial data", () => {
  const now = 2_000_000;
  const item = (
    label: string,
    usage: string,
    resetSlot: string,
    reset: string,
  ) =>
    `data-slot="usage-item"><span data-slot="usage-label">${label}</span><span data-slot="usage-value">${usage}%</span><span data-slot="${resetSlot}">${reset}</span>`;
  const html =
    item("Weekly usage", "12.5", "reset-time", "Resets in 2 hours 15 minutes") +
    item("Rolling usage", "100", "reset-now", "Reset now") +
    item("Monthly usage", "missing", "reset-time", "Resets in 1 day");
  const windows = parseOpenCodeGoHtml(html, now);
  assert.deepEqual(
    windows.map(({ label, percentRemaining, resetsAt }) => ({
      label,
      percentRemaining,
      reset: resetsAt?.getTime(),
    })),
    [
      { label: "5h", percentRemaining: 0, reset: now },
      { label: "7d", percentRemaining: 87.5, reset: now + 8_100_000 },
    ],
  );
});

test("OpenCode Go adapter distinguishes parser drift from login redirect", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  const adapter = createOpenCodeGoQuotaAdapter({
    workspaceId: "ws",
    authCookie: "secret",
  });

  globalThis.fetch = async () =>
    ({
      ok: true,
      url: "https://opencode.ai/workspace/ws/go",
      text: async () => '<div data-slot="usage-item">changed markup</div>',
    }) as Response;
  assert.equal(
    (await adapter.getQuota({}))?.error,
    "opencode-go: no usage parsed — parser may be outdated",
  );

  globalThis.fetch = async () =>
    ({
      ok: true,
      url: "https://opencode.ai/login",
      text: async () => "login",
    }) as Response;
  await assert.rejects(adapter.getQuota({}), /auth invalid or session expired/);
});
