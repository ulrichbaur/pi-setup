import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";

export type PickerFile = {
  canonicalPath: string;
  displayPath: string;
  isDirectory: boolean;
  status?: string;
};

const PAGE_SIZE = 12;

/** Selection belongs to this opening and never reads or changes the editor. */
export async function showFilePicker(
  ctx: ExtensionContext,
  files: readonly PickerFile[],
): Promise<PickerFile[] | null> {
  return ctx.ui.custom<PickerFile[] | null>((tui, theme, keybindings, done) => {
    const selected = new Set<string>();
    const container = new Container();
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    const header = new Text("", 0, 0);
    container.addChild(header);
    const search = new Input();
    container.addChild(search);
    container.addChild(new Spacer(1));
    const listContainer = new Container();
    container.addChild(listContainer);
    const instructions = new Text("", 0, 0);
    container.addChild(instructions);
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

    const items = files.map((file) => ({
      value: file.canonicalPath,
      label: `${file.displayPath}${file.isDirectory ? " [directory]" : ""}${file.status ? ` [${file.status}]` : ""}`,
    }));
    let filtered = items;
    let highlighted = 0;
    const update = () => {
      header.setText(
        theme.fg(
          "accent",
          theme.bold(` Select files (${selected.size} selected)`),
        ),
      );
      instructions.setText(
        theme.fg(
          "dim",
          "Type (including Space) to filter • Tab toggles • Enter adds selected, or highlighted if none • Esc cancels",
        ),
      );
      listContainer.clear();
      if (!filtered.length) {
        listContainer.addChild(
          new Text(theme.fg("warning", "  No matching files"), 0, 0),
        );
        return;
      }
      const list = new SelectList(
        filtered.map((item) => ({
          ...item,
          label: `[${selected.has(item.value) ? "x" : " "}] ${item.label}`,
        })),
        PAGE_SIZE,
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      );
      list.setSelectedIndex(highlighted);
      listContainer.addChild(list);
    };
    update();

    return {
      get focused() {
        return search.focused;
      },
      set focused(value: boolean) {
        search.focused = value;
      },
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        update();
        container.invalidate();
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(null);
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          if (selected.size)
            done(files.filter((file) => selected.has(file.canonicalPath)));
          else {
            const current = filtered[highlighted];
            if (current)
              done(
                files.filter((file) => file.canonicalPath === current.value),
              );
          }
          return;
        }
        if (keybindings.matches(data, "tui.input.tab")) {
          const current = filtered[highlighted];
          if (current) {
            if (selected.has(current.value)) selected.delete(current.value);
            else selected.add(current.value);
          }
        } else if (keybindings.matches(data, "tui.select.up")) {
          highlighted = filtered.length
            ? (highlighted + filtered.length - 1) % filtered.length
            : 0;
        } else if (keybindings.matches(data, "tui.select.down")) {
          highlighted = filtered.length
            ? (highlighted + 1) % filtered.length
            : 0;
        } else if (keybindings.matches(data, "tui.select.pageUp")) {
          highlighted = Math.max(0, highlighted - PAGE_SIZE);
        } else if (keybindings.matches(data, "tui.select.pageDown")) {
          highlighted = Math.max(
            0,
            Math.min(filtered.length - 1, highlighted + PAGE_SIZE),
          );
        } else {
          const previous = search.getValue();
          search.handleInput(data);
          const query = search.getValue();
          if (query !== previous) {
            filtered = query
              ? fuzzyFilter(
                  items,
                  query,
                  (item) => `${item.label} ${item.value}`,
                )
              : items;
            highlighted = 0;
          }
        }
        update();
        container.invalidate();
        tui.requestRender();
      },
    };
  });
}
