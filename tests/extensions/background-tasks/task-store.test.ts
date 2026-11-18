import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Job,
  jobDir,
  saveJob,
} from "../../../extensions/background-tasks/runner.ts";
import {
  LOG_PAGE_BYTES,
  LogLineIndex,
  markReviewed,
  readLogPage,
  sessionTasks,
  terminalText,
} from "../../../extensions/background-tasks/task-store.ts";
import { withTempDir } from "../../helpers.ts";

const id = "00112233-4455-6677-8899-aabbccddeeff";
const owner = "10112233-4455-6677-8899-aabbccddeeff";
const otherSession = "20112233-4455-6677-8899-aabbccddeeff";

test("reviewing a finished job persists only for the owning session", async () => {
  await withTempDir("background-review-", async (root) => {
    const dir = jobDir(root, owner, id);
    await mkdir(dir, { recursive: true });
    const job: Job = {
      id,
      command: "false",
      cwd: root,
      timeoutMs: null,
      state: "exited",
      exitCode: 1,
      socketPath: "",
      createdAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:03Z",
    };
    saveJob(dir, job);
    const { rows, errors } = await sessionTasks(root, owner);
    assert.deepEqual(errors, []);
    assert.equal(rows[0].reviewed, false);
    await markReviewed(rows[0]);
    assert.equal((await sessionTasks(root, owner)).rows[0].reviewed, true);
    assert.deepEqual((await sessionTasks(root, otherSession)).rows, []);
  });
});

test("large logs can be paged backward and forward, and terminal controls are stripped", async () => {
  await withTempDir("background-output-", async (dir) => {
    const lines = Array.from(
      { length: 2000 },
      (_, i) => `${i}: ${"output".repeat(14)}`,
    );
    await writeFile(join(dir, "output.log"), `${lines.join("\n")}\n`);
    const index = new LogLineIndex();
    const tail = await readLogPage(dir, undefined, index);
    assert.ok(tail.start > 0 && tail.end - tail.start <= LOG_PAGE_BYTES);
    assert.equal(tail.lines.at(-1), lines.at(-1));
    assert.equal(tail.totalLines, lines.length);
    assert.equal(tail.firstLine, lines.length - tail.lines.length + 1);
    const prior = await readLogPage(dir, { before: tail.start }, index);
    assert.equal(prior.end, tail.start);
    assert.equal(prior.firstLine + prior.lines.length, tail.firstLine);
    const forward = await readLogPage(dir, { after: prior.end }, index);
    assert.deepEqual(forward, tail);
    await appendFile(join(dir, "output.log"), "partial");
    assert.equal((await readLogPage(dir, undefined, index)).totalLines, 2001);
    await appendFile(join(dir, "output.log"), " line\n\n");
    const grown = await readLogPage(dir, undefined, index);
    assert.equal(grown.totalLines, 2002);
    assert.deepEqual(grown.lines.slice(-2), ["partial line", ""]);
    assert.equal(
      terminalText("\u001b[31mred\u001b[0m\ttext\r\u0007"),
      "red    text",
    );
  });
});
