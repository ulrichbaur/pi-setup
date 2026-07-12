/** Maintains the TUI footer and derives its session data from Pi's runtime context. */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatQuotaLine,
  formatStatusline,
  type StatusSnapshot,
} from "./format.ts";
import type { QuotaAdapter, QuotaStatus } from "./quota/types.ts";

export type StatuslineRuntime = {
  update(ctx: ExtensionContext): Promise<void>;
  dispose(ctx: ExtensionContext): void;
};

export function createStatuslineRuntime(
  pi: ExtensionAPI,
  adapters: QuotaAdapter[],
): StatuslineRuntime {
  const lastQuotaByProvider = new Map<string, QuotaStatus>();
  let footerInstalled = false;
  let latestLine = "";
  let latestQuotaLine = "";
  let requestRender: (() => void) | undefined;

  // Pi owns one footer; install it once and update the closed-over rendered values.
  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled || ctx.mode !== "tui") return;
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange?.(() =>
        tui.requestRender(),
      );
      return {
        invalidate() {},
        render(width: number): string[] {
          const pad = width > 1 ? " " : "";
          const avail = width > 1 ? width - 1 : width;
          const lines: string[] = [
            pad +
              theme
                .fg("dim", formatLocationLine(ctx, footerData.getGitBranch()))
                .slice(0, avail),
            pad + latestLine.slice(0, avail),
          ];
          const quota = latestQuotaLine.slice(0, avail);
          if (quota) lines.push(pad + quota);
          return lines;
        },
        dispose() {
          unsubscribe?.();
          if (requestRender) requestRender = undefined;
        },
      };
    });
  }

  async function update(ctx: ExtensionContext): Promise<void> {
    // TUI-only: the footer is the sole display surface.
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    const provider = ctx.model?.provider;
    const quota = await resolveQuota(ctx, adapters).catch(() => undefined);
    // Keep the last usable reading visible while a refresh is temporarily unavailable.
    if (quota && provider && (quota.windows.length > 0 || quota.error)) {
      lastQuotaByProvider.set(provider, quota);
    }

    const snapshot = createStatusSnapshot(pi, ctx, {
      quota:
        quota ?? (provider ? lastQuotaByProvider.get(provider) : undefined),
    });

    latestLine = formatStatusline(snapshot);
    latestQuotaLine = formatQuotaLine(snapshot);
    installFooter(ctx);
    requestRender?.();
  }

  function dispose(ctx: ExtensionContext): void {
    if (ctx.mode === "tui" && footerInstalled) {
      ctx.ui.setFooter(undefined);
      footerInstalled = false;
      requestRender = undefined;
    }
  }

  return { update, dispose };
}

async function resolveQuota(
  ctx: ExtensionContext,
  adapters: QuotaAdapter[],
): Promise<QuotaStatus | undefined> {
  const provider = ctx.model?.provider;
  const adapter = adapters.find(
    (candidate) =>
      candidate.provider === provider || provider?.includes(candidate.provider),
  );
  if (!adapter) return undefined;
  return adapter.getQuota({
    signal: ctx.signal,
    modelRegistry: ctx.modelRegistry,
  });
}

function formatLocationLine(
  ctx: ExtensionContext,
  branch: string | null,
): string {
  let line = formatCwdForFooter(
    ctx.cwd,
    process.env.HOME || process.env.USERPROFILE,
  );
  if (branch) line = `${line} (${branch})`;

  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) line = `${line} • ${sessionName}`;

  return line;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  // `relative` alone can escape through `..`; reject those paths before abbreviating.
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function createStatusSnapshot(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  ctx: ExtensionContext,
  overrides: Pick<StatusSnapshot, "quota"> = {},
): StatusSnapshot {
  return {
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinkingLevel: pi.getThinkingLevel(),
    context: readContextUsage(ctx),
    sessionCost: readSessionCost(ctx),
    cacheHitRate: readCacheHitRate(ctx),
    ...overrides,
  };
}

function readContextUsage(ctx: ExtensionContext): StatusSnapshot["context"] {
  const usage = ctx.getContextUsage() as
    | { tokens: number | null; contextWindow?: number }
    | undefined;
  if (usage?.tokens == null) return undefined;
  return {
    tokens: usage.tokens,
    maxTokens: usage.contextWindow ?? ctx.model?.contextWindow,
  };
}

// Sum the active branch only, excluding messages from abandoned conversation branches.
function readSessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const message = entry.message as AssistantMessage;
    total += message.usage?.cost?.total ?? 0;
  }
  return total;
}

function readCacheHitRate(ctx: ExtensionContext): number | undefined {
  // Match Pi's default footer by showing the latest assistant response's cache ratio.
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const usage = (entry.message as AssistantMessage).usage;
    if (!usage) continue;
    const promptTokens =
      (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (promptTokens > 0) return ((usage.cacheRead ?? 0) / promptTokens) * 100;
    break;
  }
  return undefined;
}
