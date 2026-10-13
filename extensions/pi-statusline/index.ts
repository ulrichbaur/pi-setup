/**
 * Replaces Pi's TUI footer with compact session details: location, branch,
 * and session name; context use, token counts, cache-hit rate, and cost;
 * provider, model, and thinking level; and the active provider's Codex or
 * OpenCode Go quota windows.
 *
 * Example (the model details are right-aligned):
 * ~/repo (main) • session-name
 * 25.0%/200k · ↑120k ↓8.4k · CH75.0% · $0.123      (openai-codex) gpt-5 • high
 * 5h: 25% ↺ 2h15m | 7d: 80% ↺ 3d4h
 *
 * Use `/statusline` to open an interactive editor for the underlying config
 * and OpenCode Go auth token.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadOpenCodeGoAuthToken } from "./auth.ts";
import {
  AUTH_PATH,
  CONFIG_PATH,
  loadConfig,
  type StatuslineConfig,
} from "./config.ts";
import {
  commitStatuslineChanges,
  type MenuState,
  showStatuslineMenu,
} from "./menu.ts";
import { withQuotaCache } from "./quota/cache.ts";
import { createCodexQuotaAdapter } from "./quota/codex.ts";
import { createOpenCodeGoQuotaAdapter } from "./quota/opencode-go.ts";
import type { QuotaAdapter, QuotaProvider } from "./quota/types.ts";
import { createStatuslineRuntime } from "./statusline.ts";

type Loaded<T> = { value?: T; error?: string };

export default async function (pi: ExtensionAPI) {
  // Load each file on its own; a broken file must not take the footer down.
  const [config, auth] = await Promise.all([
    settle(loadConfig()),
    settle(loadOpenCodeGoAuthToken()),
  ]);
  const loadErrors = [
    config.error && `Statusline config failed, quotas are off: ${config.error}`,
    auth.error && `Statusline auth failed: ${auth.error}`,
  ].filter((message): message is string => Boolean(message));
  const adapters = createQuotaAdapters(config.value, auth);

  const statusline = createStatuslineRuntime(pi, adapters);
  // Event handlers intentionally share one refresh path so all footer state stays aligned.
  const update = (ctx: ExtensionContext) => void statusline.update(ctx);

  pi.on("session_start", async (_event, ctx) => {
    for (const message of loadErrors) ctx.ui.notify(message, "error");
    update(ctx);
  });
  pi.on("model_select", async (_event, ctx) => update(ctx));
  pi.on("thinking_level_select", async (_event, ctx) => update(ctx));
  pi.on("message_end", async (_event, ctx) => update(ctx));
  pi.on("turn_end", async (_event, ctx) => update(ctx));
  pi.on("session_shutdown", async (_event, ctx) => statusline.dispose(ctx));

  pi.registerCommand("statusline", {
    description: "Edit statusline configuration and credentials",
    handler: async (_args, ctx) => {
      // Re-read so the menu reflects any external edits made since startup.
      const [liveConfig, liveToken] = await Promise.all([
        settle(loadConfig()),
        settle(loadOpenCodeGoAuthToken()),
      ]);
      // Saving from a broken file would overwrite what the user wrote; fix it by hand first.
      const error = liveConfig.error ?? liveToken.error;
      if (error || !liveConfig.value) {
        ctx.ui.notify(`Statusline menu unavailable: ${error}`, "error");
        return;
      }
      const initial: MenuState = {
        config: liveConfig.value,
        authToken: liveToken.value,
        authTokenChanged: false,
        configPath: CONFIG_PATH,
        authPath: AUTH_PATH,
      };
      const final = await showStatuslineMenu(initial, ctx);
      if (!final) return;

      try {
        await commitStatuslineChanges(final);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Statusline save error: ${message}`, "error");
        return;
      }
      ctx.ui.notify(`Saved statusline configuration to ${CONFIG_PATH}`, "info");
      await ctx.reload();
    },
  });
}

/** Builds the enabled quota adapters; a missing config means no quotas. */
export function createQuotaAdapters(
  config: StatuslineConfig | undefined,
  auth: Loaded<string | undefined>,
): QuotaAdapter[] {
  const adapters: QuotaAdapter[] = [];
  if (!config) return adapters;
  if (config.quotas.codex)
    adapters.push(withQuotaCache(createCodexQuotaAdapter()));
  if (config.quotas.opencodeGo) {
    adapters.push(
      auth.error
        ? failedAdapter("opencode-go", `opencode-go: ${auth.error}`)
        : withQuotaCache(
            createOpenCodeGoQuotaAdapter({
              workspaceId: config.opencodeGo?.workspaceId,
              authToken: auth.value,
            }),
          ),
    );
  }
  return adapters;
}

// Shows a load failure where the quota would appear.
function failedAdapter(provider: QuotaProvider, error: string): QuotaAdapter {
  return {
    provider,
    getQuota: async () => ({
      provider,
      windows: [],
      fetchedAt: new Date(),
      error,
    }),
  };
}

async function settle<T>(promise: Promise<T>): Promise<Loaded<T>> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
