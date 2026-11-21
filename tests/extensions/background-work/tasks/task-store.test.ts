import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Job,
  jobDir,
  readJob,
  saveJob,
} from "../../../../extensions/background-work/tasks/runner.ts";
import {
  interruptedTasks,
  LOG_PAGE_BYTES,
  LogLineIndex,
  markNoticeSent,
  readLogPage,
  sessionTasks,
  terminalText,
} from "../../../../extensions/background-work/tasks/task-store.ts";
import { withTempDir } from "../../../helpers.ts";
import { record, session } from "./fake-jobs.ts";

const id = "00112233-4455-6677-8899-aabbccddeeff";
const owner = "10112233-4455-6677-8899-aabbccddeeff";
const otherSession = "20112233-4455-6677-8899-aabbccddeeff";

test("a session lists only its own jobs", async () => {
  await withTempDir("background-session-", async (root) => {
    const dir = jobDir(root, owner, id);
    await mkdir(dir, { recursive: true });
    const job: Job = {
      id,
      command: "false",
      cwd: root,
      timeoutMs: null,
      state: "exited",
      exitCode: 1,
      createdAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:03Z",
    };
    saveJob(dir, job);
    const { rows, errors } = await sessionTasks(root, owner);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      rows.map((row) => [row.job.id, row.state]),
      [[id, "exited"]],
    );
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

test("jobs Pi never saw end become interrupted and are announced once", async () => {
  await withTempDir("background-interrupted-", async (root) => {
    const ids = {
      lost: "aaaaaaaa-0000-4000-8000-000000000001",
      owned: "bbbbbbbb-0000-4000-8000-000000000002",
      workerAlive: "cccccccc-0000-4000-8000-000000000003",
      byWorker: "dddddddd-0000-4000-8000-000000000004",
      announced: "eeeeeeee-0000-4000-8000-000000000005",
      finished: "ffffffff-0000-4000-8000-000000000006",
    };
    const lost = record(root, ids.lost, { startedAt: "2026-01-01" });
    await writeFile(join(lost, "output.log"), "partial\n");
    record(root, ids.owned, {});
    record(root, ids.workerAlive, { workerPid: process.pid });
    const ended = { finishedAt: "2026-01-02T00:00:00.000Z" };
    record(root, ids.byWorker, { state: "interrupted", ...ended });
    record(root, ids.announced, {
      state: "interrupted",
      noticeSent: true,
      ...ended,
    });
    record(root, ids.finished, { state: "exited", exitCode: 0, ...ended });

    const owns = (jobId: string) => jobId === ids.owned;
    const { rows, errors } = await interruptedTasks(root, session, owns);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.map((row) => row.job.id).sort(), [
      ids.lost,
      ids.byWorker,
    ]);
    // A lost job ends at its last output.
    const saved = readJob(lost);
    assert.equal(saved.state, "interrupted");
    assert.ok(Date.now() - Date.parse(saved.finishedAt ?? "") < 60_000);
    // Jobs that may still end on their own stay as they are.
    for (const id of [ids.owned, ids.workerAlive]) {
      assert.equal(readJob(jobDir(root, session, id)).finishedAt, undefined);
    }

    for (const row of rows) markNoticeSent(row);
    const again = await interruptedTasks(root, session, owns);
    assert.deepEqual(
      again.rows.map((row) => row.job.id),
      [],
    );
  });
});
