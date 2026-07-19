import {
  DynamicBorder,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

const CLEAR_VALUE = "\0clear";

/** Shows Pi's effective skill list and returns the skill to queue. */
export async function showSkillPalette(
  skills: Skill[],
  queuedSkill: Skill | null,
  ctx: ExtensionContext,
): Promise<Skill | null | undefined> {
  return ctx.ui.custom((tui, theme, keybindings, done) => {
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    const items: SelectItem[] = skills.map((skill) => ({
      value: skill.name,
      label: skill.name,
      description:
        skill.name === queuedSkill?.name
          ? `queued · ${skill.description}`
          : skill.description,
    }));
    if (queuedSkill) {
      items.unshift({
        value: CLEAR_VALUE,
        label: `Unqueue ${queuedSkill.name}`,
        description: "clear the skill queued for the next message",
      });
    }

    const container = new Container();
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Skill palette")), 1, 0),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          "type to filter • ↑↓ navigate • enter queue • esc cancel",
        ),
        1,
        0,
      ),
    );

    const search = new Input();
    container.addChild(search);

    const createList = (visibleItems: SelectItem[]) => {
      const nextList = new SelectList(
        visibleItems,
        Math.min(visibleItems.length, 12),
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      );
      nextList.onSelect = (item) =>
        done(item.value === CLEAR_VALUE ? null : byName.get(item.value));
      nextList.onCancel = () => done(undefined);
      return nextList;
    };
    let list = createList(items);
    container.addChild({
      render: (width: number) => list.render(width),
      invalidate: () => list.invalidate(),
    });
    container.addChild(
      new DynamicBorder((text: string) => theme.fg("accent", text)),
    );

    const component: Focusable & {
      render(width: number): string[];
      invalidate(): void;
      handleInput(data: string): void;
    } = {
      focused: false,
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.select.cancel")
        ) {
          list.handleInput(data);
        } else {
          search.handleInput(data);
          const query = search.getValue().trim().toLocaleLowerCase();
          list = createList(
            items.filter((item) =>
              `${item.label} ${item.description ?? ""}`
                .toLocaleLowerCase()
                .includes(query),
            ),
          );
        }
        tui.requestRender();
      },
    };
    Object.defineProperty(component, "focused", {
      get: () => search.focused,
      set: (focused: boolean) => {
        search.focused = focused;
      },
    });
    return component;
  });
}
