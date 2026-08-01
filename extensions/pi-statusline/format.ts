/** Converts session and quota data into the ANSI-styled statusline footer. */

import type { QuotaStatus, QuotaWindow } from "./quota/types.ts";

// ─── styling ────────────────────────────────────────────────────────────────

export type StatuslineStyles = {
  dim(text: string): string;
  accent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
};

// Kept as the default for formatter callers outside the TUI. The footer passes
// theme-backed styles so light and dark themes both retain suitable contrast.
const ansi = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const DEFAULT_STYLES: StatuslineStyles = {
  dim: ansi("2"),
  accent: ansi("38;5;183"),
  success: ansi("38;5;116"),
  warning: ansi("38;5;222"),
  error: ansi("38;5;211"),
};

// Reserve warning colors for the final 40% and 15% of available capacity.
function fillStyle(percent: number, styles: StatuslineStyles) {
  if (percent < 60) return styles.success;
  if (percent < 85) return styles.warning;
  return styles.error;
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
  inputTokens?: number;
  outputTokens?: number;
  sessionCost?: number;
  cacheHitRate?: number;
  quota?: QuotaStatus;
};

export function formatStatusStats(
  snapshot: StatusSnapshot,
  styles: StatuslineStyles = DEFAULT_STYLES,
): string {
  const parts: string[] = [];

  if (snapshot.context?.tokens) {
    parts.push(
      formatContext(
        snapshot.context.tokens,
        snapshot.context.maxTokens,
        styles,
      ),
    );
  }

  const tokenParts: string[] = [];
  if (snapshot.inputTokens)
    tokenParts.push(`↑${formatNumber(snapshot.inputTokens)}`);
  if (snapshot.outputTokens)
    tokenParts.push(`↓${formatNumber(snapshot.outputTokens)}`);
  if (tokenParts.length) parts.push(tokenParts.join(" "));

  if (
    typeof snapshot.cacheHitRate === "number" &&
    !Number.isNaN(snapshot.cacheHitRate)
  ) {
    parts.push(`CH${snapshot.cacheHitRate.toFixed(1)}%`);
  }

  if (typeof snapshot.sessionCost === "number" && snapshot.sessionCost > 0) {
    parts.push(
      `$${snapshot.sessionCost.toFixed(snapshot.sessionCost < 0.01 ? 4 : 3)}`,
    );
  }

  return parts.join(` ${styles.dim("·")} `);
}

export function formatModelStatus(
  snapshot: StatusSnapshot,
  styles: StatuslineStyles = DEFAULT_STYLES,
): string {
  const parts: string[] = [];
  if (snapshot.provider) parts.push(styles.dim(`(${snapshot.provider})`));

  const model = compactModel(snapshot.model);
  if (model) parts.push(styles.accent(model));
  if (!parts.length) return "";

  const thinking =
    !snapshot.thinkingLevel || snapshot.thinkingLevel === "off"
      ? "thinking off"
      : snapshot.thinkingLevel;
  return `${parts.join(" ")} ${styles.dim(`• ${thinking}`)}`;
}

export function formatQuotaLine(
  snapshot: StatusSnapshot,
  styles: StatuslineStyles = DEFAULT_STYLES,
): string {
  if (!snapshot.quota?.windows.length && !snapshot.quota?.error) return "";
  return formatQuota(snapshot.quota, styles);
}

// Provider APIs sometimes prefix IDs with this redundant registry namespace.
function compactModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model.replace(/^models\//, "");
}

function formatContext(
  tokens: number,
  maxTokens: number | undefined,
  styles: StatuslineStyles,
): string {
  if (maxTokens && maxTokens > 0) {
    const percent = (tokens / maxTokens) * 100;
    return `${fillStyle(percent, styles)(formatPercentValue(percent))}/${formatNumber(maxTokens)}`;
  }
  return formatNumber(tokens);
}

function formatQuota(quota: QuotaStatus, styles: StatuslineStyles): string {
  if (quota.error) return styles.error(quota.error);
  if (!quota.windows.length) return "";
  const line = quota.windows
    .map((window) => formatQuotaWindow(window, styles))
    .join(` ${styles.dim("|")} `);
  return quota.stale ? `${line} ${styles.dim("(stale)")}` : line;
}

function formatQuotaWindow(
  window: QuotaWindow,
  styles: StatuslineStyles,
): string {
  const percentUsed = 100 - window.percentRemaining;
  const reset = window.resetsAt
    ? ` ${styles.dim(`↺ ${formatResetCountdown(window.resetsAt)}`)}`
    : "";
  const usage = `${window.label}: ${percentUsed.toFixed(window.precision ?? 1)}%`;
  return `${fillStyle(percentUsed, styles)(usage)}${reset}`;
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
