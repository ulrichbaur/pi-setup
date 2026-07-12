/**
 * Replaces Pi's TUI footer with compact session details: location, branch,
 * provider/model, thinking level, context use, cost, cache-hit rate, and
 * optional Codex or OpenCode Go quota windows.
 *
 * Example:
 * ~/repo (main) • session-name
 * codex/gpt-5 (high) · 25.0%/200k · $0.123 CH75.0%
 * 5h: 25% ↺ 2h15m | 7d: 80% ↺ 3d4h
 *
 * Use `/statusline` to open an interactive editor for the underlying config
 * and OpenCode Go auth cookie.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadOpenCodeGoAuthCookie } from "./auth.ts";
import { AUTH_PATH, CONFIG_PATH, loadConfig } from "./config.ts";
import {
  commitStatuslineChanges,
  type MenuState,
  showStatuslineMenu,
} from "./menu.ts";
import { withQuotaCache } from "./quota/cache.ts";
import { createCodexQuotaAdapter } from "./quota/codex.ts";
import { createOpenCodeGoQuotaAdapter } from "./quota/opencode-go.ts";
import type { QuotaAdapter } from "./quota/types.ts";
import { createStatuslineRuntime } from "./statusline.ts";

export default async function (pi: ExtensionAPI) {
  const [config, authCookie] = await Promise.all([
    loadConfig(),
    loadOpenCodeGoAuthCookie(),
  ]);
  const adapters: QuotaAdapter[] = [];

  if (config.quotas.codex)
    adapters.push(withQuotaCache(createCodexQuotaAdapter()));
  if (config.quotas.opencodeGo) {
    adapters.push(
      withQuotaCache(
        createOpenCodeGoQuotaAdapter({
          workspaceId: config.opencodeGo?.workspaceId,
          authCookie,
        }),
      ),
    );
  }

  const statusline = createStatuslineRuntime(pi, adapters);
  // Event handlers intentionally share one refresh path so all footer state stays aligned.
  const update = (ctx: ExtensionContext) => void statusline.update(ctx);

  pi.on("session_start", async (_event, ctx) => update(ctx));
  pi.on("model_select", async (_event, ctx) => update(ctx));
  pi.on("thinking_level_select", async (_event, ctx) => update(ctx));
  pi.on("message_end", async (_event, ctx) => update(ctx));
  pi.on("turn_end", async (_event, ctx) => update(ctx));
  pi.on("session_shutdown", async (_event, ctx) => statusline.dispose(ctx));

  pi.registerCommand("statusline", {
    description: "Edit statusline configuration and credentials",
    handler: async (_args, ctx) => {
      // Re-read so the menu reflects any external edits made since startup.
      const [liveConfig, liveCookie] = await Promise.all([
        loadConfig(),
        loadOpenCodeGoAuthCookie(),
      ]);
      const initial: MenuState = {
        config: liveConfig,
        authCookie: liveCookie,
        authCookieChanged: false,
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
