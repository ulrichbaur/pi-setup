import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JobRegistry } from "../../../extensions/background-tasks/registry.ts";
import {
  jobDir,
  readJob,
} from "../../../extensions/background-tasks/runner.ts";
import { taskStatus } from "../../../extensions/background-tasks/status.ts";
import { withTempDir } from "../../helpers.ts";
import { record, running, session, until } from "./fake-jobs.ts";

const FINISHED = "aaaaaaaa-0000-4000-8000-000000000001";
const RUNNING = "bbbbbbbb-0000-4000-8000-000000000002";
const BROKEN = "cccccccc-0000-4000-8000-000000000003";

test("an empty session has no jobs", async () => {
  await withTempDir("pi-bg-status-", async (root) => {
    assert.deepEqual(await taskStatus(root, session), []);
  });
});

test("the list shows each job without output, unreadable records last", async () => {
  await withTempDir("pi-bg-status-", async (root) => {
    const finishedDir = record(root, FINISHED, {
      label: "Test suite",
      command: "npm test",
      state: "exited",
      exitCode: 1,
      signal: null,
      timeoutMs: 1_800_000,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:41.210Z",
    });
    record(root, RUNNING, { startedAt: "2026-01-01T00:00:00.000Z" });
    const broken = jobDir(root, session, BROKEN);
    mkdirSync(broken);
    writeFileSync(join(broken, "job.json"), "{ broken");

    const [live, finished, unreadable, ...rest] = await taskStatus(
      root,
      session,
    );
    assert.deepEqual(rest, []);
    assert.deepEqual(finished, {
      jobId: FINISHED,
      label: "Test suite",
      command: "npm test",
      state: "exited",
      exitCode: 1,
      elapsedMs: 41_210,
      timeoutMs: 1_800_000,
      logPath: join(finishedDir, "output.log"),
    });
    // A running job's elapsed time runs to now.
    assert.equal(live.jobId, RUNNING);
    assert.equal(live.state, "running");
    assert.ok((live.elapsedMs ?? 0) > 41_210);
    assert.equal(unreadable.jobId, BROKEN);
    assert.equal(unreadable.state, "unreadable");
    assert.match(unreadable.error ?? "", /JSON/);
  });
});

test("one job shows the last 20 lines of its log, capped in size", async () => {
  await withTempDir("pi-bg-status-", async (root) => {
    const dir = record(root, FINISHED, {
      command: "x".repeat(300),
      state: "exited",
      exitCode: 0,
      finishedAt: "2026-01-01T00:00:00.000Z",
    });
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "output.log"), `${lines.join("\n")}\n`);
    const [job] = await taskStatus(root, session, "aaaa");
    assert.equal(job.command?.length, 200);
    assert.equal(job.outputTail, lines.slice(-20).join("\n"));

    writeFileSync(join(dir, "output.log"), "y".repeat(10_000));
    const [long] = await taskStatus(root, session, FINISHED);
    assert.equal(long.outputTail, "y".repeat(4_000));
  });
});

test("unknown, ambiguous, and invalid job IDs fail", async () => {
  await withTempDir("pi-bg-status-", async (root) => {
    const finished = { state: "exited" as const, finishedAt: "2026-01-01" };
    record(root, FINISHED, finished);
    record(root, "aaaaaaaa-0000-4000-8000-000000000009", finished);
    await assert.rejects(
      taskStatus(root, session, "dddd"),
      /No such background job in this session/,
    );
    await assert.rejects(
      taskStatus(root, session, "aaaa"),
      /Multiple jobs match/,
    );
    await assert.rejects(
      taskStatus(root, session, "not a job"),
      /Invalid background job ID: not a job/,
    );
  });
});

test("a running job reports a growing elapsed time, then its exit", {
  skip: process.platform === "win32",
  timeout: 20_000,
}, async () => {
  await withTempDir("pi-bg-status-", async (root) => {
    const dir = await running(
      new JobRegistry(),
      root,
      "printf 'started\\n'; while [ ! -e done ]; do sleep 0.05; done",
    );
    const { id } = readJob(dir);
    const [first] = await taskStatus(root, session, id);
    assert.equal(first.state, "running");
    assert.equal(first.exitCode, undefined);
    await delay(100);
    const [second] = await taskStatus(root, session, id);
    assert.ok((second.elapsedMs ?? 0) > (first.elapsedMs ?? 0));

    writeFileSync(join(root, "done"), "");
    await until(() => readJob(dir).finishedAt !== undefined);
    const [ended] = await taskStatus(root, session, id);
    assert.equal(ended.state, "exited");
    assert.equal(ended.exitCode, 0);
    assert.equal(ended.outputTail, "started");
  });
});
