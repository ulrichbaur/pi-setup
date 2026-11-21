import assert from "node:assert/strict";
import { test } from "node:test";
import { footerText } from "../../../extensions/background-tasks/footer.ts";
import type { JobState } from "../../../extensions/background-tasks/runner.ts";
import type { TaskRow } from "../../../extensions/background-tasks/task-store.ts";

function row(
  state: JobState | "unknown",
  fields: { exitCode?: number; finished?: boolean } = {},
): TaskRow {
  return {
    state,
    dir: "/jobs/x",
    job: {
      id: "00112233-4455-6677-8899-aabbccddeeff",
      command: "true",
      cwd: "/",
      timeoutMs: null,
      socketPath: "/tmp/x.sock",
      createdAt: "2026-01-01T00:00:00.000Z",
      state: state === "unknown" ? "running" : state,
      ...(fields.finished && { finishedAt: "2026-01-01T00:01:00.000Z" }),
      ...(fields.exitCode !== undefined && { exitCode: fields.exitCode }),
    },
  };
}

test("the footer status is labeled and counts only current jobs", () => {
  assert.equal(
    footerText(
      [
        row("running"),
        row("exited", { finished: true, exitCode: 2 }),
        row("exited", { finished: true, exitCode: 0 }),
        row("unknown"),
      ],
      [],
      true,
    ),
    "Tasks: 1 running · 1 unknown",
  );
});

test("unavailable jobs and notices are named without repeating the label", () => {
  assert.equal(
    footerText([row("running")], ["x: broken"], false),
    "Tasks: 1 running · some unavailable · notices unavailable",
  );
  assert.equal(footerText([], ["x: broken"], true), "Tasks: some unavailable");
});

test("finished jobs alone show no status", () => {
  assert.equal(
    footerText(
      [
        row("exited", { finished: true, exitCode: 0 }),
        row("exited", { finished: true, exitCode: 2 }),
      ],
      [],
      true,
    ),
    undefined,
  );
});
