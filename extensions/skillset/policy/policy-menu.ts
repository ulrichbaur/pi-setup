/** Interactive editor for the skill auto-invocation allowlist. */

import {
  DynamicBorder,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

export type SkillMenuItem = {
  name: string;
  description?: string;
  loaded: boolean;
};

type MenuAction =
  | { kind: "toggle"; name: string }
  | { kind: "clear" }
  | { kind: "save" }
  | { kind: "discard" };

/** Resolves with a working allowlist on save, or null when discarded. */
export async function showSkillPolicyMenu(
  skills: SkillMenuItem[],
  initialAllowed: ReadonlySet<string>,
  ctx: ExtensionContext,
): Promise<Set<string> | null> {
  const allowed = new Set(initialAllowed);

  while (true) {
    const action = await showMenu(skills, allowed, ctx);
    if (action.kind === "toggle") {
      if (allowed.has(action.name)) allowed.delete(action.name);
      else allowed.add(action.name);
    } else if (action.kind === "clear") {
      allowed.clear();
    } else if (action.kind === "save") {
      return allowed;
    } else {
      return null;
    }
  }
}

async function showMenu(
  skills: SkillMenuItem[],
  allowed: ReadonlySet<string>,
  ctx: ExtensionContext,
): Promise<MenuAction> {
  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const skillItems: SelectItem[] = skills.map((skill) => {
      const status = allowed.has(skill.name) ? "auto-allowed" : "manual-only";
      const details = skill.loaded
        ? skill.description
        : "configured but not currently loaded";
      return {
        value: `skill:${skill.name}`,
        label: skill.name,
        description: details ? `${status} · ${details}` : status,
      };
    });
    const items: SelectItem[] = [
      ...skillItems,
      {
        value: "clear",
        label: "Make all manual-only",
        description: `${allowed.size} currently auto-allowed`,
      },
      {
        value: "save",
        label: "Save & exit",
        description: "persist the displayed policy",
      },
      {
        value: "discard",
        label: "Discard & exit",
        description: "close without saving",
      },
    ];

    const container = new Container();
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Skill policy")), 1, 0),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          "select a skill to toggle • enter select • esc discards",
        ),
        1,
        0,
      ),
    );

    const list = new SelectList(items, Math.min(items.length, 15), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(actionFor(item.value));
    list.onCancel = () => done({ kind: "discard" });
    container.addChild(list);
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );

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

function actionFor(value: string): MenuAction {
  if (value.startsWith("skill:")) {
    return { kind: "toggle", name: value.slice("skill:".length) };
  }
  if (value === "clear") return { kind: "clear" };
  if (value === "save") return { kind: "save" };
  return { kind: "discard" };
}
