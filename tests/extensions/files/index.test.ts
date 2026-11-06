import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import files from "../../../extensions/files/index.ts";
import { withTempDir } from "../../helpers.ts";

test("files registers alt+o instead of ctrl+shift+o", () => {
  const shortcuts: string[] = [];
  const commands: string[] = [];
  files({
    registerCommand(name: string) {
      commands.push(name);
    },
    registerShortcut(shortcut: string) {
      shortcuts.push(shortcut);
    },
  } as unknown as ExtensionAPI);

  assert.deepEqual(commands, ["files"]);
  assert.deepEqual(shortcuts, ["alt+o"]);
  assert.ok(!shortcuts.includes("ctrl+shift+o"));
});

test("confirmation appends once to the exact existing draft; cancel and reopen leave it alone", async () => {
  await withTempDir("files-picker-", async (directory) => {
    await writeFile(join(directory, "alpha.ts"), "alpha");
    await writeFile(join(directory, "beta.ts"), "beta");
    let command: any;
    let shortcut: any;
    files({
      registerCommand(_name: string, options: any) {
        command = options.handler;
      },
      registerShortcut(_key: string, options: any) {
        shortcut = options.handler;
      },
      async exec(_tool: string, args: string[]) {
        return {
          code: 0,
          stdout:
            args[0] === "rev-parse"
              ? directory
              : args[0] === "ls-files"
                ? "alpha.ts\0beta.ts\0"
                : "",
        };
      },
    } as unknown as ExtensionAPI);
    const original = "  Existing @alpha.ts draft\nwith exact whitespace\t";
    let draft = original;
    let writes = 0;
    let opens = 0;
    const context = {
      mode: "tui",
      cwd: directory,
      sessionManager: { getBranch: () => [] },
      ui: {
        notify() {},
        select() {
          assert.fail("no per-file action menu");
        },
        getEditorText() {
          return draft;
        },
        setEditorText(value: string) {
          writes += 1;
          draft = value;
        },
        custom: (build: any) =>
          new Promise((resolve) => {
            opens += 1;
            const component = build(
              { requestRender() {} },
              {
                fg: (_: string, value: string) => value,
                bold: (value: string) => value,
              },
              {
                matches: (data: string, action: string) =>
                  ({
                    "tui.select.down": "down",
                    "tui.select.confirm": "enter",
                    "tui.select.cancel": "esc",
                    "tui.input.tab": "tab",
                  })[action] === data,
              },
              resolve,
            );
            assert.match(component.render(120).join("\n"), /0 selected/);
            component.handleInput("tab");
            component.handleInput("down");
            component.handleInput("tab");
            if (opens === 1) {
              assert.equal(writes, 0);
              assert.equal(draft, original);
              component.handleInput("enter");
            } else {
              assert.equal(writes, 1);
              component.handleInput("esc");
            }
          }),
      },
    };
    await command("", context);
    assert.equal(draft, `${original}@alpha.ts @beta.ts`);
    assert.equal(writes, 1);
    assert.equal(opens, 1);
    await shortcut(context);
    assert.equal(draft, `${original}@alpha.ts @beta.ts`);
    assert.equal(writes, 1);
    assert.equal(opens, 2);
  });
});
