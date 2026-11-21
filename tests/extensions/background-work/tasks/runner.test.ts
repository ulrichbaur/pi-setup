import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createJob,
  DEFAULT_TIMEOUT_MS,
  jobDir,
  MAX_TIMER_MS,
  readJob,
} from "../../../../extensions/background-work/tasks/runner.ts";
import { withTempDir } from "../../../helpers.ts";
import { session } from "./fake-jobs.ts";

const otherSession = "10112233-4455-6677-8899-aabbccddeeff";

test("a new job is recorded below its session, not yet started", async () => {
  await withTempDir("pi-bg-runner-", async (root) => {
    const { job, dir } = createJob(root, session, {
      cwd: root,
      command: "true",
      label: "Check",
    });
    assert.equal(dir, join(root, session, job.id));
    assert.deepEqual(readJob(dir), job);
    assert.equal(job.state, "starting");
    assert.equal(job.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(existsSync(jobDir(root, otherSession, job.id)), false);
    assert.throws(
      () => jobDir(root, "../other-session", job.id),
      /Invalid Pi session ID/,
    );
    assert.equal(
      createJob(root, session, { cwd: root, command: "true", timeoutMs: null })
        .job.timeoutMs,
      null,
    );
  });
});

test("an invalid job spec is rejected before anything is written", async () => {
  await withTempDir("pi-bg-runner-", async (root) => {
    assert.throws(
      () => createJob(root, session, { cwd: "relative", command: "true" }),
      /absolute cwd/,
    );
    assert.throws(
      () => createJob(root, session, { cwd: root, command: "  " }),
      /a command/,
    );
    for (const timeoutMs of [0, 1.5, MAX_TIMER_MS + 1]) {
      assert.throws(
        () =>
          createJob(root, session, { cwd: root, command: "true", timeoutMs }),
        /timeoutMs must be null or an integer/,
      );
    }
    assert.equal(existsSync(join(root, session)), false);
  });
});
