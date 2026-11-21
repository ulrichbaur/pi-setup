import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSections,
  completions,
  itemStatus,
  itemTitle,
  resolveItem,
  type Snapshot,
  sectionItems,
} from "../../../extensions/background-work/rows.ts";
import { savedRuns } from "../../../extensions/background-work/subagents/restore.ts";
import { sessionRows } from "../../../extensions/background-work/subagents/session-view.ts";
import type { Job } from "../../../extensions/background-work/tasks/runner.ts";
import type { TaskRow } from "../../../extensions/background-work/tasks/task-store.ts";
import { fakeRun } from "./subagents/fake-run.ts";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

function task(id: string, fields: Partial<Job>): TaskRow {
  const job: Job = {
    id,
    command: "npm test",
    cwd: "/",
    timeoutMs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "running",
    ...fields,
  };
  return { job, state: job.state, dir: `/jobs/${id}` };
}

function agent(
  sessionId: string,
  status: Parameters<typeof fakeRun>[1],
  startedAt?: string,
) {
  const run = fakeRun(sessionId, status);
  if (startedAt) run.startedAt = Date.parse(startedAt);
  return run;
}

const running = task("a1f03e00-0000-4000-8000-000000000001", {
  label: "Build",
  startedAt: "2026-01-01T00:05:00.000Z",
});
const failed = task("c2000000-0000-4000-8000-000000000002", {
  state: "exited",
  exitCode: 2,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:14.000Z",
});
const snapshot: Snapshot = { rows: [running, failed], errors: [] };
const runs = [
  agent("analyst-9f8e7d6c", "pending"),
  agent("scout-1a2b3c4d", "running", "2026-01-01T00:08:00.000Z"),
  agent("scout-77aa01bc", "completed"),
];
runs[0].result.task = "Review the diff\nwith care";
runs[2].result.question = "Which color?";
runs[2].result.progress.durationMs = 32_000;
const sections = buildSections(snapshot, runs);

test("active work comes first, newest first, then each kind's history", () => {
  const ids = (items: typeof sections.active) => items.map((item) => item.id);
  assert.deepEqual(ids(sections.active), [
    "analyst-9f8e7d6c",
    "scout-1a2b3c4d",
    running.job.id,
  ]);
  assert.deepEqual(ids(sections.shellHistory), [failed.job.id]);
  assert.deepEqual(ids(sections.subagentHistory), ["scout-77aa01bc"]);
  assert.equal(sectionItems(sections).length, 5);
  assert.equal(sections.active[2].shortId, "a1f03");
});

test("both kinds read their status in words, with elapsed time", () => {
  const status = (id: string) =>
    itemStatus(
      sectionItems(sections).find((item) => item.id === id) ?? assert.fail(id),
      NOW,
    );
  assert.deepEqual(status("analyst-9f8e7d6c"), { text: "Queued", tone: "dim" });
  assert.deepEqual(status("scout-1a2b3c4d"), {
    text: "Running · 2m 0s",
    tone: "warning",
  });
  assert.deepEqual(status("scout-77aa01bc"), {
    text: "Completed · 32s",
    tone: "success",
  });
  assert.deepEqual(status(failed.job.id), {
    text: "Failed (exit 2) · 14s",
    tone: "error",
  });
  assert.equal(status(running.job.id).tone, "warning");
});

test("titles show the label or command, or the task's first line", () => {
  const title = (id: string) =>
    itemTitle(
      sectionItems(sections).find((item) => item.id === id) ?? assert.fail(id),
    );
  assert.equal(title(running.job.id), "Build");
  assert.equal(title(failed.job.id), "npm test");
  assert.equal(title("analyst-9f8e7d6c"), "Review the diff");
  assert.equal(
    title("scout-77aa01bc"),
    "task of scout-77aa01bc · asks the parent",
  );
});

test("a prefix names one item, several, or none", () => {
  const found = (prefix: string) => resolveItem(sections, snapshot, prefix);
  assert.deepEqual(found("scout-1"), {
    item: sections.active[1],
  });
  assert.deepEqual(found("C2"), { item: sections.shellHistory[0] });
  // Agent names can start with hexadecimal letters.
  assert.deepEqual(found("a"), {
    error: "Multiple jobs or subagents match. Enter a longer prefix.",
  });
  assert.deepEqual(found("zz"), {
    error: "No such background job or subagent in this session",
  });
  const unreadable = { rows: [], errors: ["d300: broken record"] };
  assert.deepEqual(
    resolveItem(buildSections(unreadable, []), unreadable, "d3"),
    { error: "d300: broken record" },
  );
});

test("completions name each entry's kind, jobs first", () => {
  const entries = completions(sections, "a");
  assert.deepEqual(
    entries.map(({ value, description }) => [
      value,
      description.split(" · ")[0],
    ]),
    [
      ["a1f03", "task"],
      ["analyst-9f8e7d6c", "agent"],
    ],
  );
  assert.match(entries[0].description, /^task · Running · \d+m \d+s · Build$/);
  assert.equal(entries[1].description, "agent · Queued · Review the diff");
  // A typed prefix longer than the short ID is kept.
  assert.equal(completions(sections, "a1f03e0")[0].value, "a1f03e0");
});

test("stopped and interrupted subagents read as neither success nor failure", () => {
  const runs = [
    fakeRun("scout-00000011", "stopped"),
    fakeRun("scout-00000012", "interrupted"),
  ];
  const [stopped, interrupted] = buildSections(undefined, runs).subagentHistory;
  assert.deepEqual(itemStatus(stopped), {
    text: "Stopped · 0s",
    tone: "muted",
  });
  assert.deepEqual(itemStatus(interrupted), {
    text: "Interrupted · 0s",
    tone: "muted",
  });
});

test("a subagent row shows its session's cost once it has one", () => {
  const run = fakeRun("scout-00000021", "completed");
  run.result.progress.durationMs = 32_000;
  run.result.usage.cost = 0.042;
  const [item] = buildSections(undefined, [run]).subagentHistory;
  assert.deepEqual(itemStatus(item), {
    text: "Completed · 32s · $0.042",
    tone: "success",
  });
  run.result.usage.cost = 0.0031;
  assert.equal(itemStatus(item).text, "Completed · 32s · $0.0031");
  // Queued runs have no time yet, but a continued session has a cost.
  run.result.progress.status = "pending";
  assert.equal(itemStatus(item).text, "Queued · $0.0031");
});

test("an old result without a session ID leaves no row and no error", () => {
  const old = { ...fakeRun("scout-00000031", "completed").result };
  delete (old as Partial<typeof old>).sessionId;
  const runs = savedRuns(
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { results: [old] },
        },
      },
    ],
    "subagent-result",
  );
  const sections = buildSections(undefined, sessionRows(runs));
  assert.deepEqual(sectionItems(sections), []);
  assert.deepEqual(completions(sections, "s"), []);
});

test("an old launch and its delivered result show as one finished row", () => {
  const launch = fakeRun("scout-00000041", "pending").result;
  const delivered = fakeRun("scout-00000041", "completed").result;
  const runs = savedRuns(
    [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "subagent",
          details: { background: true, results: [launch] },
        },
      },
      {
        type: "custom_message",
        customType: "subagent-result",
        details: { results: [delivered] },
      },
    ],
    "subagent-result",
  );
  // The registry lists runs newest first.
  const sections = buildSections(undefined, sessionRows([...runs].reverse()));
  assert.deepEqual(sections.active, []);
  assert.equal(sections.subagentHistory.length, 1);
  assert.match(itemStatus(sections.subagentHistory[0]).text, /^Completed/);
});
