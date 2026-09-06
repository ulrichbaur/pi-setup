import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCodexQuotaAdapter,
  normalizeCodexUsage,
} from "../../../../extensions/pi-statusline/quota/codex.ts";

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

test("Codex adapter reports definitive failures instead of throwing", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));

  const expired = createCodexQuotaAdapter({
    readAuth: async () => ({
      accessToken: "token",
      accountId: "acct",
      expiresAt: Date.now() - 1_000,
    }),
  });
  assert.equal(
    (await expired.getQuota({}))?.error,
    "codex: token expired, re-run pi login",
  );

  const adapter = createCodexQuotaAdapter({
    readAuth: async () => ({ accessToken: "token", accountId: "acct" }),
  });
  globalThis.fetch = async () =>
    ({ ok: true, json: async () => ({ unexpected: true }) }) as Response;
  assert.equal(
    (await adapter.getQuota({}))?.error,
    "codex: no usage parsed, response shape may have changed",
  );

  globalThis.fetch = async () => ({ ok: false, status: 404 }) as Response;
  await assert.rejects(adapter.getQuota({}), /request failed \(404\)/);
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
