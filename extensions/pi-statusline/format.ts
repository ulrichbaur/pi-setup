/** Converts session and quota data into the ANSI-styled statusline footer. */

import type { QuotaStatus, QuotaWindow } from "./quota/types.ts";

// ─── ANSI colors ────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const DIM = "\x1b[2m";
// Usage colors move from comfortable to warning as a limit fills.
const FOAM = "\x1b[38;5;116m";
const GOLD = "\x1b[38;5;222m";
const LOVE = "\x1b[38;5;211m";
const IRIS = "\x1b[38;5;183m"; // Model-name accent.

const SEP = `${DIM}·${R}`;

// Reserve warning colors for the final 40% and 15% of available capacity.
function fillColor(percent: number): string {
  if (percent < 60) return FOAM;
  if (percent < 85) return GOLD;
  return LOVE;
}

function usedColor(percentUsed: number): string {
  if (percentUsed < 60) return FOAM;
  if (percentUsed < 85) return GOLD;
  return LOVE;
}

// ─── snapshot / format ──────────────────────────────────────────────────────

export type StatusSnapshot = {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  context?: {
    tokens?: number;
    maxTokens?: number;
  };
  sessionCost?: number;
  cacheHitRate?: number;
  quota?: QuotaStatus;
};

export function formatStatusline(snapshot: StatusSnapshot): string {
  const parts: string[] = [];

  const model = compactModel(snapshot.model);
  const modelPart =
    snapshot.provider && model
      ? `${snapshot.provider}/${model}`
      : snapshot.provider || model;
  if (modelPart) parts.push(formatModelPart(modelPart, snapshot.thinkingLevel));

  if (snapshot.context?.tokens) {
    parts.push(
      formatContext(snapshot.context.tokens, snapshot.context.maxTokens),
    );
  }

  const costParts: string[] = [];
  if (typeof snapshot.sessionCost === "number" && snapshot.sessionCost > 0) {
    costParts.push(
      `$${snapshot.sessionCost.toFixed(snapshot.sessionCost < 0.01 ? 4 : 3)}`,
    );
  }
  if (
    typeof snapshot.cacheHitRate === "number" &&
    !Number.isNaN(snapshot.cacheHitRate)
  ) {
    costParts.push(`CH${snapshot.cacheHitRate.toFixed(1)}%`);
  }
  if (costParts.length) parts.push(costParts.join(" "));

  return parts.join(` ${SEP} `);
}

export function formatQuotaLine(snapshot: StatusSnapshot): string {
  if (!snapshot.quota?.windows.length && !snapshot.quota?.error) return "";
  return formatQuota(snapshot.quota);
}

// Provider APIs sometimes prefix IDs with this redundant registry namespace.
function compactModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.replace(/^models\//, "");
}

function formatModelPart(
  modelPart: string,
  thinkingLevel: string | undefined,
): string {
  const colored = `${IRIS}${modelPart}${R}`;
  if (!thinkingLevel || thinkingLevel === "off") return colored;
  return `${colored} ${DIM}(${thinkingLevel})${R}`;
}

function formatContext(tokens: number, maxTokens: number | undefined): string {
  if (maxTokens && maxTokens > 0) {
    const percent = (tokens / maxTokens) * 100;
    const color = fillColor(percent);
    return `${color}${formatPercentValue(percent)}${R}/${formatNumber(maxTokens)}`;
  }
  return formatNumber(tokens);
}

function formatQuota(quota: QuotaStatus): string {
  if (quota.error) return quota.error;
  if (!quota.windows.length) return "";
  const line = quota.windows.map(formatQuotaWindow).join(` ${DIM}|${R} `);
  return quota.stale ? `${line} ${DIM}(stale)${R}` : line;
}

function formatQuotaWindow(window: QuotaWindow): string {
  const percentUsed = 100 - window.percentRemaining;
  const color = usedColor(percentUsed);
  const reset = window.resetsAt
    ? ` ${DIM}↺ ${formatResetCountdown(window.resetsAt)}${R}`
    : "";
  return `${color}${window.label}: ${percentUsed.toFixed(window.precision ?? 1)}%${R}${reset}`;
}

// Round to seconds so countdowns do not imply sub-second precision.
function formatResetCountdown(resetsAt: Date): string {
  const totalSeconds = Math.max(
    0,
    Math.round((resetsAt.getTime() - Date.now()) / 1000),
  );
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatPercentValue(value: number): string {
  return value >= 1 ? `${value.toFixed(1)}%` : `${value.toFixed(2)}%`;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimFixed(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
