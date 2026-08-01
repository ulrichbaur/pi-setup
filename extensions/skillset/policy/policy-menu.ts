/** Interactive editor for the skill auto-invocation allowlist. */

import {
  DynamicBorder,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";

export type SkillMenuItem = {
  name: string;
  description?: string;
  loaded: boolean;
};

/** Resolves with the displayed allowlist when the editor closes. */
export async function showSkillPolicyMenu(
  skills: SkillMenuItem[],
  initialAllowed: ReadonlySet<string>,
  ctx: ExtensionContext,
): Promise<Set<string>> {
  const allowed = new Set(initialAllowed);

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = skills.map((skill) => ({
      id: skill.name,
      label: skill.name,
      description: skill.loaded
        ? skill.description
        : "configured but not currently loaded",
      currentValue: allowed.has(skill.name) ? "auto-allowed" : "manual-only",
      values: ["auto-allowed", "manual-only"],
    }));

    const container = new Container();
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Skill policy")), 1, 0),
    );

    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      {
        label: (text, selected) => (selected ? theme.fg("accent", text) : text),
        value: (text, selected) =>
          theme.fg(selected ? "accent" : "muted", text),
        description: (text) => theme.fg("dim", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text) => theme.fg("dim", text),
      },
      (name, value) => {
        if (value === "auto-allowed") allowed.add(name);
        else allowed.delete(name);
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return allowed;
}
