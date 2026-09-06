import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenCodeGoQuotaAdapter,
  parseOpenCodeGoHtml,
} from "../../../../extensions/pi-statusline/quota/opencode-go.ts";

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
    "opencode-go: no usage parsed \u2014 parser may be outdated",
  );

  globalThis.fetch = async () =>
    ({
      ok: true,
      url: "https://opencode.ai/login",
      text: async () => "login",
    }) as Response;
  await assert.rejects(adapter.getQuota({}), /auth invalid or session expired/);
});
