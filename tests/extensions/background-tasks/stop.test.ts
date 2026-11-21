import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jobDir,
  readJob,
  startJob,
  stopJob,
} from "../../../extensions/background-tasks/runner.ts";
import {
  stopTask,
  stopText,
} from "../../../extensions/background-tasks/stop.ts";
import { withTempDir } from "../../helpers.ts";
import { record, running, session, until } from "./fake-jobs.ts";

const options = { skip: process.platform === "win32", timeout: 20_000 };

test(
  "a running job stops by unique prefix and the tool waits for it",
  options,
  async () => {
    await withTempDir("pi-bg-stop-", async (root) => {
      const dir = await running(root, "sleep 30");
      const { id } = readJob(dir);
      const outcome = await stopTask(root, session, id.slice(0, 8), {});
      assert.equal(outcome.alreadyEnded, false);
      assert.equal(outcome.job.state, "stopped");
      assert.ok(outcome.job.finishedAt);
      assert.equal(
        stopText(outcome),
        `Stopped background job ${id}${outcome.job.signal ? ` (${outcome.job.signal})` : ""}.`,
      );
    });
  },
);

test(
  "a job that outlasts the wait is reported as still stopping",
  options,
  async () => {
    await withTempDir("pi-bg-stop-", async (root) => {
      const dir = await running(
        root,
        "trap '' TERM; while :; do sleep 0.05; done",
      );
      try {
        const outcome = await stopTask(root, session, readJob(dir).id, {
          waitMs: 100,
        });
        assert.equal(outcome.job.finishedAt, undefined);
        assert.match(stopText(outcome), /It is still stopping\./);
      } finally {
        await stopJob(dir);
        await until(() => readJob(dir).finishedAt !== undefined);
      }
    });
  },
);

test(
  "a finished job reports its final state without an error",
  options,
  async () => {
    await withTempDir("pi-bg-stop-", async (root) => {
      const job = await startJob(root, session, {
        cwd: root,
        command: "exit 3",
      });
      const dir = jobDir(root, session, job.id);
      await until(() => readJob(dir).finishedAt !== undefined);
      const outcome = await stopTask(root, session, job.id, {});
      assert.equal(outcome.alreadyEnded, true);
      assert.equal(
        stopText(outcome),
        `Background job ${job.id} had already ended: exited (exit 3).`,
      );
    });
  },
);

test("unknown, ambiguous, invalid, and unreachable jobs fail", async () => {
  await withTempDir("pi-bg-stop-", async (root) => {
    const finished = { state: "exited" as const, finishedAt: "2026-01-01" };
    record(root, "aaaaaaaa-0000-4000-8000-000000000001", finished);
    record(root, "aaaaaaaa-0000-4000-8000-000000000002", finished);
    record(root, "bbbbbbbb-0000-4000-8000-000000000003", {});
    await assert.rejects(
      stopTask(root, session, "cccc", {}),
      /No such background job in this session/,
    );
    await assert.rejects(
      stopTask(root, session, "aaaa", {}),
      /Multiple jobs match/,
    );
    await assert.rejects(
      stopTask(root, session, "not a job", {}),
      /Invalid background job ID: not a job/,
    );
    await assert.rejects(
      stopTask(root, session, "bbbb", {}),
      /Could not reach the supervisor of background job bbbbbbbb-.*Its state is unknown\./,
    );
  });
});
