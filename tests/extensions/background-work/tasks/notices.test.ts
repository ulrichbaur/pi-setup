import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  NOTICE_TYPE,
  noticeText,
  sendTaskNotice,
} from "../../../../extensions/background-work/tasks/notices.ts";
import type { Job } from "../../../../extensions/background-work/tasks/runner.ts";
import type { TaskRow } from "../../../../extensions/background-work/tasks/task-store.ts";

function row(fields: Partial<Job>): TaskRow {
  const job: Job = {
    id: "00112233-4455-6677-8899-aabbccddeeff",
    command: "true",
    cwd: "/",
    timeoutMs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    state: "exited",
    exitCode: 0,
    ...fields,
  };
  return { job, state: job.state, dir: "/jobs/x" };
}

test("each outcome reads as one sentence with the job's details", () => {
  const first = (fields: Partial<Job>) =>
    noticeText(row(fields), "00112").split("\n")[0];
  assert.equal(
    first({ label: "Build" }),
    "Background task (Build) completed · exit 0.",
  );
  assert.equal(first({ exitCode: 2 }), "Background task failed · exit 2.");
  assert.equal(
    first({ state: "failed", startedAt: undefined, exitCode: undefined }),
    "Background task failed to start.",
  );
  assert.equal(
    first({ state: "timed_out", exitCode: null, signal: "SIGKILL" }),
    "Background task timed out · SIGKILL.",
  );
  assert.equal(
    first({ state: "stopped", exitCode: undefined }),
    "Background task stopped.",
  );
  assert.equal(
    first({ state: "interrupted", exitCode: undefined }),
    "Background task interrupted when Pi closed.",
  );
  assert.deepEqual(noticeText(row({}), "00112").split("\n").slice(1), [
    "Details: /tasks 00112",
    "Output log: /jobs/x/output.log",
  ]);
});

test("one notice carries several jobs and the turn choice", () => {
  const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const pi = { sendMessage: (...args) => sent.push(args) } as Pick<
    ExtensionAPI,
    "sendMessage"
  >;
  sendTaskNotice(pi, [], true);
  assert.equal(sent.length, 0);
  sendTaskNotice(
    pi,
    [
      { row: row({ id: "a" }), shortId: "a" },
      { row: row({ id: "b", state: "stopped" }), shortId: "b" },
    ],
    false,
  );
  const [[message, options]] = sent;
  assert.equal(message.customType, NOTICE_TYPE);
  assert.deepEqual(message.details, { jobIds: ["a", "b"] });
  assert.match(String(message.content), /completed[\s\S]*\n\n[\s\S]*stopped/);
  assert.deepEqual(options, { deliverAs: "steer", triggerTurn: false });
});
