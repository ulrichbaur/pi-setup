import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import {
  type PickerFile,
  showFilePicker,
} from "../../../extensions/files/picker.ts";

const files: PickerFile[] = ["alpha.ts", "beta.ts", "gamma.ts"].map((name) => ({
  canonicalPath: `/project/${name}`,
  displayPath: name,
  isDirectory: false,
}));
const bindings: Record<string, string[]> = {
  "tui.select.up": ["\u001b[A"],
  "tui.select.down": ["\u001b[B"],
  "tui.select.pageUp": ["\u001b[5~"],
  "tui.select.pageDown": ["\u001b[6~"],
  "tui.select.confirm": ["\r"],
  "tui.select.cancel": ["\u001b"],
  "tui.input.tab": ["\t"],
};

type PickerComponent = {
  focused: boolean;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
};

async function pick(
  drive: (component: PickerComponent, isDone: () => boolean) => void,
  inventory = files,
): Promise<PickerFile[] | null> {
  let completed = false;
  return showFilePicker(
    {
      ui: {
        getEditorText() {
          assert.fail("picker must not read draft");
        },
        setEditorText() {
          assert.fail("picker must not mutate draft");
        },
        custom: (build: any) =>
          new Promise((resolve) => {
            const component = build(
              { requestRender() {} },
              {
                fg: (_: string, value: string) => value,
                bold: (value: string) => value,
              },
              {
                matches: (data: string, action: string) =>
                  bindings[action]?.includes(data) ?? false,
              },
              (value: PickerFile[] | null) => {
                completed = true;
                resolve(value);
              },
            );
            drive(component, () => completed);
          }),
      },
    } as unknown as ExtensionContext,
    inventory,
  );
}

const screen = (component: PickerComponent) => component.render(120).join("\n");

test("toggles multiple checkboxes without closing and preserves hidden selections across filtering", async () => {
  const selected = await pick((component, done) => {
    assert.match(screen(component), /Select files \(0 selected\)/);
    assert.doesNotMatch(screen(component), /\[x\]/);
    component.handleInput("\t");
    assert.equal(done(), false);
    assert.match(screen(component), /\[x\] alpha.ts/);
    component.handleInput("\t");
    assert.match(screen(component), /0 selected/);
    component.handleInput("\t");
    for (const char of "beta") component.handleInput(char);
    assert.doesNotMatch(screen(component), /alpha.ts/);
    assert.match(screen(component), /1 selected/);
    component.handleInput("\t");
    assert.match(screen(component), /2 selected/);
    assert.match(screen(component), /\[x\] beta.ts/);
    for (let i = 0; i < 4; i += 1) component.handleInput("\u007f");
    assert.match(screen(component), /\[x\] alpha.ts/);
    assert.match(screen(component), /\[x\] beta.ts/);
    component.handleInput("\r");
  });
  assert.deepEqual(selected, files.slice(0, 2));
});

test("Enter without toggles adds the highlighted file and a fresh opening starts unchecked", async () => {
  await pick((component) => {
    component.handleInput("\t");
    component.handleInput("\r");
  });
  const result = await pick((component) => {
    assert.match(screen(component), /0 selected/);
    component.handleInput("\u001b[B");
    component.handleInput("\r");
  });
  assert.deepEqual(result, [files[1]]);
});

test("Space edits the query, empty results keep checked files, and cancel returns no selection", async () => {
  assert.equal(
    await pick((component) => {
      component.handleInput("\t");
      for (const char of "no match") component.handleInput(char);
      assert.match(screen(component), /no match/);
      assert.match(screen(component), /No matching files/);
      assert.match(screen(component), /1 selected/);
      component.handleInput("\u001b");
    }),
    null,
  );
  const selected = await pick((component) => {
    component.handleInput("\t");
    component.handleInput("zzzz");
    component.handleInput("\r");
  });
  assert.deepEqual(selected, [files[0]]);
});

test("Enter on an empty unselected result stays open, query cursor movement preserves highlight", async () => {
  const result = await pick((component, done) => {
    component.handleInput("zzzz");
    component.handleInput("\r");
    assert.equal(done(), false);
    for (let i = 0; i < 4; i += 1) component.handleInput("\u007f");
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[D");
    component.handleInput("\r");
  });
  assert.deepEqual(result, [files[1]]);
});

test("paging scrolls the list and focus propagates to the search input at narrow widths", async () => {
  const inventory = Array.from({ length: 30 }, (_, index) => ({
    canonicalPath: `/project/file-${index}`,
    displayPath: `file-${index}`,
    isDirectory: false,
  }));
  const result = await pick((component) => {
    component.focused = true;
    assert.equal(component.focused, true);
    assert.ok(screen(component).includes(CURSOR_MARKER));
    component.handleInput("\u001b[6~");
    assert.match(screen(component), /→ \[ \] file-12/);
    component.handleInput("\t");
    component.invalidate();
    assert.match(screen(component), /1 selected/);
    for (const line of component.render(28))
      assert.ok(visibleWidth(line) <= 28);
    component.handleInput("\u001b[5~");
    component.handleInput("\r");
  }, inventory);
  assert.deepEqual(result, [inventory[12]]);
});
