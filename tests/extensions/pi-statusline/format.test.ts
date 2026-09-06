import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatModelStatus,
  formatQuotaLine,
  formatStatusStats,
} from "../../../extensions/pi-statusline/format.ts";
import type { QuotaStatus } from "../../../extensions/pi-statusline/quota/types.ts";

const stripAnsi = (value: string) =>
  value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

const quota = (overrides: Partial<QuotaStatus> = {}): QuotaStatus => ({
  provider: "codex",
  windows: [{ label: "5h", percentRemaining: 75, precision: 0 }],
  fetchedAt: new Date(),
  ...overrides,
});

test("formats default-like stats and right-aligned model details", () => {
  const snapshot = {
    provider: "anthropic",
    model: "models/claude-sonnet",
    thinkingLevel: "high",
    inputTokens: 125_000,
    outputTokens: 8_200,
    context: { tokens: 25_000, maxTokens: 100_000 },
    sessionCost: 1.2345,
    cacheHitRate: 80,
  };

  assert.equal(
    stripAnsi(formatStatusStats(snapshot)),
    "25.0%/100k · ↑125k ↓8.2k · CH80.0% · $1.234",
  );
  assert.equal(
    stripAnsi(formatModelStatus(snapshot)),
    "(anthropic) claude-sonnet • high",
  );
  assert.equal(
    stripAnsi(formatStatusStats({ context: { tokens: 999 } })),
    "999",
  );
  assert.equal(formatStatusStats({ sessionCost: 0 }), "");
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
    stripAnsi(
      formatQuotaLine({
        quota: quota({ windows: [], error: "quota unavailable" }),
      }),
    ),
    "quota unavailable",
  );
  assert.equal(formatQuotaLine({ quota: quota({ windows: [] }) }), "");
});
