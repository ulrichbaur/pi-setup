/** Fetches OpenCode Go usage from the console JSON API and normalizes meter windows. */

import type {
  QuotaAdapter,
  QuotaAdapterContext,
  QuotaStatus,
  QuotaWindow,
} from "./types.ts";

export type OpenCodeGoOptions = {
  /** Sent as `x-org-id`. The status endpoint requires it. */
  workspaceId?: string;
  /** Sent as a Bearer token. */
  authToken?: string;
};

const STATUS_URL = "https://opencode.ai/console/api/go/status";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const FETCH_TIMEOUT_MS = 10_000;

/** A failure whose message is already fit for the footer. */
class OpenCodeGoError extends Error {}

// The API encodes micro-cent amounts as whole numbers, usually as strings.
function parseMicroCents(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  return typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : undefined;
}

function parseMeter(
  meter: unknown,
  label: "5h" | "7d" | "30d",
): QuotaWindow | undefined {
  if (!isRecord(meter)) return undefined;
  const limit = parseMicroCents(meter.limitMicroCents);
  if (limit === undefined || limit <= 0) return undefined;
  const used = parseMicroCents(meter.usedMicroCents ?? 0);
  if (used === undefined) return undefined;

  const percentRemaining = Math.min(
    100,
    Math.max(0, 100 - (used / limit) * 100),
  );
  const resetsAt =
    typeof meter.resetsAt === "string" && meter.resetsAt
      ? new Date(meter.resetsAt)
      : undefined;

  return {
    label,
    percentRemaining,
    resetsAt:
      resetsAt instanceof Date && !Number.isNaN(resetsAt.getTime())
        ? resetsAt
        : undefined,
  };
}

export function parseOpenCodeGoStatus(data: unknown): QuotaWindow[] {
  if (!isRecord(data)) return [];
  const access = isRecord(data.access) ? data.access : undefined;
  const meters = isRecord(access?.meters) ? access.meters : undefined;
  if (!meters) return [];

  const windows: QuotaWindow[] = [];
  for (const window of [
    parseMeter(meters.fiveHour, "5h"),
    parseMeter(meters.week, "7d"),
    parseMeter(meters.month, "30d"),
  ]) {
    if (window) windows.push(window);
  }
  return windows;
}

export function createOpenCodeGoQuotaAdapter(
  options: OpenCodeGoOptions,
): QuotaAdapter {
  return {
    provider: "opencode-go",
    async getQuota(ctx: QuotaAdapterContext): Promise<QuotaStatus | undefined> {
      const workspaceId = options.workspaceId?.trim();
      const authToken = options.authToken?.trim();
      if (!workspaceId || !authToken) {
        const missing = [];
        if (!workspaceId) missing.push("workspaceId");
        if (!authToken) missing.push("pi-statusline.auth.json authToken");
        return errorStatus(`opencode-go: set ${missing.join(" + ")}`);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      // Respect Pi shutdown/cancellation as well as the console request timeout.
      const onAbort = () => controller.abort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await fetch(STATUS_URL, {
          headers: {
            // The server checks Bearer before cookies, so cookies add nothing.
            Authorization: `Bearer ${authToken}`,
            "x-org-id": workspaceId,
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (response.status === 401) {
          return errorStatus("opencode-go: auth token rejected or expired");
        }
        if (!response.ok) {
          const tag = await errorTag(response);
          if (response.status === 400 && tag === "OrgRequired") {
            return errorStatus(
              "opencode-go: workspace ID rejected (OrgRequired)",
            );
          }
          throw new OpenCodeGoError(
            `OpenCode Go status error ${response.status}${tag ? ` (${tag})` : ""}`,
          );
        }

        // A login page or proxy can answer with HTML; do not parse it as JSON.
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          throw new OpenCodeGoError(
            `OpenCode Go returned an unexpected response (${contentType || "no content type"})`,
          );
        }

        const windows = parseOpenCodeGoStatus(await response.json());
        if (!windows.length) {
          return errorStatus(
            "opencode-go: no usage meters (no active plan, or the API changed)",
          );
        }
        return { provider: "opencode-go", windows, fetchedAt: new Date() };
      } catch (err) {
        if (err instanceof OpenCodeGoError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `OpenCode Go quota fetch failed: ${message.slice(0, 200)}`,
        );
      } finally {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function errorStatus(error: string): QuotaStatus {
  return { provider: "opencode-go", windows: [], fetchedAt: new Date(), error };
}

// Error bodies look like `{"_tag":"OrgRequired"}`. Show only the tag, never raw body text.
async function errorTag(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await response.text());
    const tag = isRecord(body) ? body._tag : undefined;
    return typeof tag === "string" && /^\w{1,64}$/.test(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
