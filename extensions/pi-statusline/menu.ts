/**
 * Interactive menu for editing the statusline config and OpenCode Go auth cookie.
 *
 * The menu keeps a working copy of the config and cookie in memory and reports
 * back the user's verdict ("save" or "discard"). The caller decides when to
 * persist the working state so the menu never touches disk on its own.
 */

import {
  DynamicBorder,
  type ExtensionContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import { saveOpenCodeGoAuthCookie } from "./auth.ts";
import { type StatuslineConfig, saveConfig } from "./config.ts";

export type MenuState = {
  config: StatuslineConfig;
  authCookie: string | undefined;
  authCookieChanged: boolean;
  configPath: string;
  authPath: string;
};

type TopAction =
  | { kind: "edit-quotas" }
  | { kind: "edit-workspace" }
  | { kind: "edit-auth" }
  | { kind: "show-config" }
  | { kind: "save" }
  | { kind: "discard" };

// Resolves with the final working state on "save", or null on "discard".
export async function showStatuslineMenu(
  initial: MenuState,
  ctx: ExtensionContext,
): Promise<MenuState | null> {
  let current = initial;
  while (true) {
    const action = await showTopMenu(current, ctx);
    if (action.kind === "edit-quotas") {
      const next = await showQuotasMenu(current.config, ctx);
      current = { ...current, config: next };
    } else if (action.kind === "edit-workspace") {
      const result = await ctx.ui.input(
        "OpenCode Go workspace ID",
        "Leave empty to clear",
      );
      if (result !== undefined) {
        const trimmed = result.trim();
        const existing = current.config.opencodeGo ?? {};
        const { workspaceId: _drop, ...rest } = existing;
        const opencodeGo = trimmed
          ? { ...rest, workspaceId: trimmed }
          : Object.keys(rest).length > 0
            ? rest
            : undefined;
        current = { ...current, config: { ...current.config, opencodeGo } };
      }
    } else if (action.kind === "edit-auth") {
      const result = await ctx.ui.input(
        "OpenCode Go auth cookie",
        "Paste the cookie (leave empty to keep current)",
      );
      if (result !== undefined) {
        const trimmed = result.trim();
        if (trimmed) {
          current = {
            ...current,
            authCookie: trimmed,
            authCookieChanged: true,
          };
        }
      }
    } else if (action.kind === "show-config") {
      await showConfigDialog(current, ctx);
    } else if (action.kind === "save") {
      return current;
    } else if (action.kind === "discard") {
      return null;
    }
  }
}

// Write the working state to disk; called by index.ts after the menu resolves.
export async function commitStatuslineChanges(state: MenuState): Promise<void> {
  if (state.authCookieChanged && state.authCookie) {
    await saveOpenCodeGoAuthCookie(state.authCookie, state.authPath);
  }
  await saveConfig(state.config, state.configPath);
}

// -- Top menu -----------------------------------------------------------

async function showTopMenu(
  state: MenuState,
  ctx: ExtensionContext,
): Promise<TopAction> {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const items: SelectItem[] = [
      {
        value: "edit-quotas",
        label: "Quotas",
        description: quotaSummary(state.config.quotas),
      },
      {
        value: "edit-workspace",
        label: "OpenCode Go workspace ID",
        description: state.config.opencodeGo?.workspaceId ?? "(unset)",
      },
      {
        value: "edit-auth",
        label: "OpenCode Go auth cookie",
        description: state.authCookie ? "(set)" : "(unset)",
      },
      {
        value: "show-config",
        label: "Show current config",
        description: state.configPath,
      },
      {
        value: "save",
        label: "Save & reload",
        description: state.authCookieChanged
          ? "persist pending changes"
          : "rewrite config (no auth changes)",
      },
      {
        value: "discard",
        label: "Discard & exit",
        description: "close menu without saving",
      },
    ];

    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Statusline settings")), 1, 0),
    );
    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ navigate • enter select • esc discards"),
        1,
        0,
      ),
    );

    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    list.onSelect = (item) => done(actionFor(item.value));
    list.onCancel = () => done({ kind: "discard" });
    container.addChild(list);
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function actionFor(value: string): TopAction {
  switch (value) {
    case "edit-quotas":
      return { kind: "edit-quotas" };
    case "edit-workspace":
      return { kind: "edit-workspace" };
    case "edit-auth":
      return { kind: "edit-auth" };
    case "show-config":
      return { kind: "show-config" };
    case "save":
      return { kind: "save" };
    case "discard":
      return { kind: "discard" };
    default:
      return { kind: "discard" };
  }
}

function quotaSummary(quotas: StatuslineConfig["quotas"]): string {
  const on: string[] = [];
  if (quotas.codex) on.push("codex");
  if (quotas.opencodeGo) on.push("opencode-go");
  return on.length > 0 ? on.join(" · ") : "all disabled";
}

// -- Quotas submenu -----------------------------------------------------

async function showQuotasMenu(
  config: StatuslineConfig,
  ctx: ExtensionContext,
): Promise<StatuslineConfig> {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    let current = config;
    const items: SettingItem[] = [
      {
        id: "codex",
        label: "Codex quota",
        currentValue: config.quotas.codex ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      },
      {
        id: "opencodeGo",
        label: "OpenCode Go quota",
        currentValue: config.quotas.opencodeGo ? "enabled" : "disabled",
        values: ["enabled", "disabled"],
      },
    ];

    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Quotas")), 1, 0),
    );

    const list = new SettingsList(
      items,
      Math.min(items.length, 10),
      getSettingsListTheme(),
      (id, newValue) => {
        const enabled = newValue === "enabled";
        if (id === "codex") {
          current = {
            ...current,
            quotas: { ...current.quotas, codex: enabled },
          };
        } else if (id === "opencodeGo") {
          current = {
            ...current,
            quotas: { ...current.quotas, opencodeGo: enabled },
          };
        }
      },
      () => done(current),
      { enableSearch: false },
    );
    container.addChild(list);
    container.addChild(
      new Text(theme.fg("dim", "←/→/space toggle • esc done"), 1, 0),
    );
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

// -- Config display -----------------------------------------------------

async function showConfigDialog(
  state: MenuState,
  ctx: ExtensionContext,
): Promise<void> {
  const json = JSON.stringify(state.config, null, 2);
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Current config")), 1, 0),
    );
    container.addChild(new Text(theme.fg("dim", state.configPath), 1, 0));
    container.addChild(new Text(json, 1, 0));
    container.addChild(new Text(theme.fg("dim", "esc / enter to close"), 1, 0));
    container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
          done(undefined);
        }
      },
    };
  });
}
