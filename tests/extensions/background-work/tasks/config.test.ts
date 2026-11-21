import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadShortcut } from "../../../../extensions/background-work/tasks/config.ts";
import { withTempDir } from "../../../helpers.ts";

test("the task shortcut defaults to Alt+T and can be changed or disabled", async () => {
  await withTempDir("background-shortcut-", async (dir) => {
    const path = join(dir, "background-tasks.json");
    assert.equal(await loadShortcut(path), "alt+t");
    for (const shortcut of ["alt+shift+t", "ctrl++", false]) {
      await writeFile(path, JSON.stringify({ shortcut }));
      assert.equal(await loadShortcut(path), shortcut);
    }
    await writeFile(path, JSON.stringify({ shortcut: "alt+alt+t" }));
    await assert.rejects(loadShortcut(path), (error: Error) =>
      error.message.startsWith(path),
    );
  });
});
