import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { findLogMatch } from "../../../extensions/background-tasks/log-search.ts";
import { readLogPage } from "../../../extensions/background-tasks/task-store.ts";
import { withTempDir } from "../../helpers.ts";

test("search finds literal matches beyond the viewport and wraps in either direction", async () => {
  await withTempDir("background-search-", async (dir) => {
    const prefix = "start [x]\n";
    const middle = "界".repeat(30_000);
    const ending = "\n\u001b[31mend [x]\u001b[0m";
    await writeFile(join(dir, "output.log"), prefix + middle + ending);
    const first = { line: 1, offset: 0 };
    const last = { line: 3, offset: Buffer.byteLength(`${prefix}${middle}\n`) };
    assert.deepEqual(await findLogMatch(dir, "[x]", 2, 1), last);
    assert.deepEqual(await findLogMatch(dir, "[x]", 4, 1), first);
    assert.deepEqual(await findLogMatch(dir, "[x]", 2, -1), first);
    assert.deepEqual(await findLogMatch(dir, "[x]", 0, -1), last);
    assert.equal(await findLogMatch(dir, "missing", 1, 1), undefined);
    assert.equal(
      (await readLogPage(dir, { after: last.offset })).lines[0],
      "end [x]",
    );
  });
});
