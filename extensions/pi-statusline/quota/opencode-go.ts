/** Scrapes OpenCode Go dashboard usage and normalizes its changing HTML formats. */

import type {
  QuotaAdapter,
  QuotaAdapterContext,
  QuotaStatus,
  QuotaWindow,
} from "./types.ts";

export type OpenCodeGoOptions = {
  workspaceId?: string;
  authCookie?: string;
};

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const SCRAPE_TIMEOUT_MS = 10_000;

interface ScrapedWindow {
  usagePercent: number;
  resetInSec: number;
}

// Extract usage embedded in the dashboard's client-side data assignments.
function parseWindow(html: string, name: string): ScrapedWindow | null {
  const body = new RegExp(String.raw`${name}:\$R\[\d+\]=\{([^}]*)\}`).exec(
    html,
  )?.[1];
  if (!body) return null;
  const usagePercent = Number(/usagePercent:(-?\d+(?:\.\d+)?)/.exec(body)?.[1]);
  const resetInSec = Number(/resetInSec:(-?\d+(?:\.\d+)?)/.exec(body)?.[1]);
  return Number.isFinite(usagePercent) && Number.isFinite(resetInSec)
    ? { usagePercent, resetInSec }
    : null;
}

// ─── data-slot HTML fallback ─────────────────────────────────────────────────

// The HTML fallback reports resets as prose rather than seconds.
function parseHumanReadableTime(timeStr: string): number | null {
  const normalized = timeStr.toLowerCase().trim().replace(/\s+/g, " ");
  if (["reset-now", "reset now", "now", "resets now"].includes(normalized))
    return 0;

  let total = 0;
  const day = normalized.match(/(\d+(?:\.\d+)?)\s*days?/);
  const hour = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  const min = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  const sec = normalized.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  const hasDuration = Boolean(day || hour || min || sec);

  if (day) total += Number(day[1]) * 86_400;
  if (hour) total += Number(hour[1]) * 3_600;
  if (min) total += Number(min[1]) * 60;
  if (sec) total += Number(sec[1]);

  return hasDuration ? total : null;
}

function parseDataSlotFormat(
  html: string,
): Partial<Record<"rolling" | "weekly" | "monthly", ScrapedWindow>> {
  const result: Partial<
    Record<"rolling" | "weekly" | "monthly", ScrapedWindow>
  > = {};
  const items = html.split(/data-slot="usage-item"/);

  for (let i = 1; i < items.length; i++) {
    const content = items[i];

    const labelMatch = content.match(/data-slot="usage-label">([^<]+)</);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim().toLowerCase();

    const usageMatch = content.match(
      /data-slot="usage-value">[^<0-9]*(\d+(?:\.\d+)?)[^<]*<\/span>/,
    );
    if (!usageMatch) continue;
    const usagePercent = Number(usageMatch[1]);

    const resetMatch = content.match(
      /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/,
    );
    if (!resetMatch) continue;

    const resetContent = resetMatch[2]
      .replace(/<!--\$-->/g, "")
      .replace(/<!--\/-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .trim();

    const resetInSec =
      resetMatch[1] === "reset-now" ? 0 : parseHumanReadableTime(resetContent);

    if (
      !Number.isFinite(usagePercent) ||
      resetInSec === null ||
      !Number.isFinite(resetInSec)
    )
      continue;

    let windowKey: "rolling" | "weekly" | "monthly" | null = null;
    if (label.includes("rolling")) windowKey = "rolling";
    else if (label.includes("weekly")) windowKey = "weekly";
    else if (label.includes("monthly")) windowKey = "monthly";

    if (windowKey) result[windowKey] = { usagePercent, resetInSec };
  }

  return result;
}

function looksLikeDashboard(html: string): boolean {
  return (
    html.includes("rollingUsage") ||
    html.includes("weeklyUsage") ||
    html.includes("monthlyUsage") ||
    html.includes('data-slot="usage-item"')
  );
}

// ─── main adapter ────────────────────────────────────────────────────────────

function decimalPlacesOf(value: number): number {
  const parts = String(value).split(".");
  return parts[1]?.length ?? 0;
}

function buildQuotaWindows(
  scraped: Partial<Record<"rolling" | "weekly" | "monthly", ScrapedWindow>>,
  now = Date.now(),
): QuotaWindow[] {
  const windowDefs: Array<{
    key: "rolling" | "weekly" | "monthly";
    label: "5h" | "7d" | "30d";
  }> = [
    { key: "rolling", label: "5h" },
    { key: "weekly", label: "7d" },
    { key: "monthly", label: "30d" },
  ];

  const windows: QuotaWindow[] = [];

  for (const def of windowDefs) {
    const w = scraped[def.key];
    if (
      !w ||
      !Number.isFinite(w.usagePercent) ||
      !Number.isFinite(w.resetInSec)
    )
      continue;

    const percentRemaining = Math.min(100, Math.max(0, 100 - w.usagePercent));
    const precision = decimalPlacesOf(w.usagePercent);
    windows.push({
      label: def.label,
      percentRemaining,
      precision,
      resetsAt: new Date(now + Math.max(0, w.resetInSec) * 1000),
    });
  }

  return windows;
}

export function parseOpenCodeGoHtml(
  html: string,
  now = Date.now(),
): QuotaWindow[] {
  let rolling: ScrapedWindow | undefined =
    parseWindow(html, "rollingUsage") ?? undefined;
  let weekly: ScrapedWindow | undefined =
    parseWindow(html, "weeklyUsage") ?? undefined;
  let monthly: ScrapedWindow | undefined =
    parseWindow(html, "monthlyUsage") ?? undefined;

  // Prefer structured client data; fall back when the dashboard ships rendered data-slot markup.
  if (!rolling && !weekly && !monthly) {
    const dataSlot = parseDataSlotFormat(html);
    rolling = dataSlot.rolling;
    weekly = dataSlot.weekly;
    monthly = dataSlot.monthly;
  }
  return buildQuotaWindows({ rolling, weekly, monthly }, now);
}

export function createOpenCodeGoQuotaAdapter(
  options: OpenCodeGoOptions,
): QuotaAdapter {
  return {
    provider: "opencode-go",
    async getQuota(ctx: QuotaAdapterContext): Promise<QuotaStatus | undefined> {
      const { workspaceId, authCookie } = options;
      if (!workspaceId || !authCookie) {
        const missing = [];
        if (!workspaceId) missing.push("workspaceId");
        if (!authCookie) missing.push("pi-statusline.auth.json authCookie");
        return {
          provider: "opencode-go",
          windows: [],
          fetchedAt: new Date(),
          error: `opencode-go: set ${missing.join(" + ")}`,
        };
      }

      const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

      // Respect Pi shutdown/cancellation as well as the dashboard request timeout.
      const onAbort = () => controller.abort();
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await fetch(url, {
          headers: {
            Cookie: `auth=${authCookie}`,
            "User-Agent": USER_AGENT,
            Accept: "text/html",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`OpenCode Go dashboard error ${response.status}`);
        }

        // A login redirect can still return 200, so verify that fetch stayed on the dashboard.
        if (!response.url.includes(`/workspace/${workspaceId}/go`)) {
          throw new Error("OpenCode Go auth invalid or session expired");
        }

        const html = await response.text();

        const windows = parseOpenCodeGoHtml(html);
        if (!windows.length) {
          // Page fetched and looks like the dashboard, but nothing parsed:
          // the markup likely changed. Surface that instead of vanishing.
          if (looksLikeDashboard(html)) {
            return {
              provider: "opencode-go",
              windows: [],
              fetchedAt: new Date(),
              error: "opencode-go: no usage parsed — parser may be outdated",
            };
          }
          throw new Error(
            "OpenCode Go response does not look like the dashboard",
          );
        }
        return { provider: "opencode-go", windows, fetchedAt: new Date() };
      } catch (err) {
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
