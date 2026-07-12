/** Fetches Codex usage with Pi credentials and normalizes its rate-limit response. */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  QuotaAdapter,
  QuotaAdapterContext,
  QuotaStatus,
  QuotaWindow,
} from "./types.ts";

// Codex has used both paths; try each so a backend migration does not remove the quota line.
export const CODEX_USAGE_URLS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
] as const;
const AUTH_FILE = join(
  process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
  "auth.json",
);

type CodexCredentials = {
  accessToken: string;
  accountId: string;
  /** Epoch ms; only known when read from auth.json. */
  expiresAt?: number;
};

type UsageWindow = {
  used_percent?: number | null;
  reset_after_seconds?: number | null;
  reset_at?: number | null;
  /** The backend uses this to distinguish model-specific rolling windows. */
  limit_window_seconds?: number | null;
};

type RateLimitBucket = {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: UsageWindow | null;
  secondary_window?: UsageWindow | null;
};

type CodexUsageResponse = {
  rate_limit?: RateLimitBucket | null;
};

export function createCodexQuotaAdapter(): QuotaAdapter {
  return {
    provider: "codex",
    async getQuota(ctx) {
      const credentials = await getCodexCredentials(ctx);
      if (!credentials) return undefined;
      if (
        credentials.expiresAt !== undefined &&
        credentials.expiresAt < Date.now()
      ) {
        throw new Error("Codex token expired — re-run pi login");
      }

      const headers = {
        accept: "*/*",
        authorization: `Bearer ${credentials.accessToken}`,
        "chatgpt-account-id": credentials.accountId,
      };

      let lastStatus: number | undefined;
      for (const url of CODEX_USAGE_URLS) {
        const response = await fetch(url, { headers, signal: ctx.signal });
        if (!response.ok) {
          lastStatus = response.status;
          continue;
        }
        return normalizeCodexUsage(
          (await response.json()) as CodexUsageResponse,
        );
      }
      throw new Error(`Codex usage request failed (${lastStatus})`);
    },
  };
}

async function getCodexCredentials(
  ctx: QuotaAdapterContext,
): Promise<CodexCredentials | undefined> {
  // Prefer the registry's current token; auth.json is a fallback for existing Pi logins.
  const registryToken = await ctx.modelRegistry
    ?.getApiKeyForProvider("openai-codex")
    .catch(() => undefined);
  return (
    parseCodexRegistryCredentials(registryToken) ?? (await readCodexAuth())
  );
}

function parseCodexRegistryCredentials(
  raw: string | undefined,
): CodexCredentials | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const accountId = extractAccountIdFromJwt(value);
  return accountId ? { accessToken: value, accountId } : undefined;
}

async function readCodexAuth(): Promise<CodexCredentials | undefined> {
  try {
    const auth = JSON.parse(await readFile(AUTH_FILE, "utf8")) as unknown;
    if (!isRecord(auth)) return undefined;
    const entry = auth["openai-codex"];
    if (!isRecord(entry) || entry.type !== "oauth") return undefined;
    const accessToken =
      typeof entry.access === "string" ? entry.access.trim() : undefined;
    const accountId =
      typeof entry.accountId === "string"
        ? entry.accountId.trim()
        : typeof entry.account_id === "string"
          ? entry.account_id.trim()
          : undefined;
    const expiresAt =
      typeof entry.expires === "number" && Number.isFinite(entry.expires)
        ? entry.expires
        : undefined;
    return accessToken && accountId
      ? { accessToken, accountId, expiresAt }
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeCodexUsage(
  data: CodexUsageResponse,
): QuotaStatus | undefined {
  const bucket = data.rate_limit;
  if (!isRecord(bucket)) return undefined;
  const windows = [
    normalizeWindow(
      windowLabel(bucket.primary_window, "5h"),
      bucket.primary_window,
    ),
    normalizeWindow(
      windowLabel(bucket.secondary_window, "7d"),
      bucket.secondary_window,
    ),
  ].filter((window): window is QuotaWindow => window !== undefined);
  return windows.length
    ? { provider: "codex", windows, fetchedAt: new Date() }
    : undefined;
}

// Clamp provider values before display and retain their decimal precision.
function normalizeWindow(
  label: string,
  window: UsageWindow | null | undefined,
): QuotaWindow | undefined {
  const usedPercent = window?.used_percent;
  if (typeof usedPercent !== "number" || Number.isNaN(usedPercent))
    return undefined;
  const percentRemaining = Math.min(100, Math.max(0, 100 - usedPercent));
  const precision = decimalPlacesOf(usedPercent);
  const resetSeconds = getResetSeconds(window);
  return {
    label,
    percentRemaining,
    precision,
    resetsAt:
      resetSeconds === undefined
        ? undefined
        : new Date(Date.now() + resetSeconds * 1000),
  };
}

// Newer Codex models may expose only a weekly bucket in primary_window. Do not
// call it "5h" merely because of its position in the response.
function windowLabel(
  window: UsageWindow | null | undefined,
  fallback: "5h" | "7d",
): string {
  const seconds = window?.limit_window_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    return fallback;
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function decimalPlacesOf(value: number): number {
  const parts = String(value).split(".");
  return parts[1]?.length ?? 0;
}

function getResetSeconds(
  window: UsageWindow | null | undefined,
): number | undefined {
  if (
    typeof window?.reset_after_seconds === "number" &&
    !Number.isNaN(window.reset_after_seconds)
  )
    return Math.max(0, window.reset_after_seconds);
  if (typeof window?.reset_at !== "number" || Number.isNaN(window.reset_at))
    return undefined;
  // The endpoint has returned both epoch seconds and milliseconds.
  const resetAtSeconds =
    window.reset_at > 100_000_000_000
      ? window.reset_at / 1000
      : window.reset_at;
  return Math.max(0, resetAtSeconds - Date.now() / 1000);
}

// The Codex API requires the ChatGPT account ID, which the registry token embeds in its JWT payload.
function extractAccountIdFromJwt(token: string): string | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const parsed = JSON.parse(decodeBase64Url(payload)) as unknown;
    const auth = isRecord(parsed)
      ? parsed["https://api.openai.com/auth"]
      : undefined;
    const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
    return typeof accountId === "string" && accountId.trim()
      ? accountId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
