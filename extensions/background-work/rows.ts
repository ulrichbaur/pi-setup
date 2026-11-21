import { formatCost } from "../../lib/subagent-cost.ts";
import type { SubagentRun } from "./subagents/runs.ts";
import { isActive } from "./subagents/runs.ts";
import { elapsed, taskStatusLabel } from "./tasks/task-detail.ts";
import {
  active,
  displayJobId,
  type sessionTasks,
  type TaskRow,
  terminalText,
} from "./tasks/task-store.ts";

export type Snapshot = Awaited<ReturnType<typeof sessionTasks>>;

/** One shell job or one subagent session in the view. */
export type Item =
  | { kind: "task"; key: string; id: string; shortId: string; row: TaskRow }
  | {
      kind: "agent";
      key: string;
      id: string;
      shortId: string;
      run: SubagentRun;
    };

export interface Sections {
  active: Item[];
  shellHistory: Item[];
  subagentHistory: Item[];
}

export type Tone = "success" | "error" | "warning" | "dim" | "muted";

function taskItem(row: TaskRow, snapshot: Snapshot): Item {
  return {
    kind: "task",
    key: `task:${row.job.id}`,
    id: row.job.id,
    shortId: displayJobId(row.job.id, snapshot),
    row,
  };
}

function agentItem(run: SubagentRun): Item {
  const id = run.result.sessionId;
  return { kind: "agent", key: `agent:${id}`, id, shortId: id, run };
}

function itemActive(item: Item): boolean {
  return item.kind === "task" ? active(item.row) : isActive(item.run);
}

/** When the item started; a queued subagent counts as the newest. */
function startTime(item: Item): number {
  if (item.kind === "task")
    return Date.parse(item.row.job.startedAt ?? item.row.job.createdAt);
  return item.run.startedAt ?? Number.POSITIVE_INFINITY;
}

/**
 * Active work of both kinds, newest first, then each kind's history.
 * `snapshot` rows are ordered as the task store sorts them, and `runs` as
 * session rows, newest first.
 */
export function buildSections(
  snapshot: Snapshot | undefined,
  runs: SubagentRun[] | undefined,
): Sections {
  const tasks = (snapshot?.rows ?? []).map((row) =>
    taskItem(row, snapshot as Snapshot),
  );
  const agents = (runs ?? []).map(agentItem);
  return {
    active: [...tasks, ...agents]
      .filter(itemActive)
      .sort((a, b) => startTime(b) - startTime(a)),
    shellHistory: tasks.filter((item) => !itemActive(item)),
    subagentHistory: agents.filter((item) => !itemActive(item)),
  };
}

export function sectionItems(sections: Sections): Item[] {
  return [
    ...sections.active,
    ...sections.shellHistory,
    ...sections.subagentHistory,
  ];
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}

const AGENT_STATUS: Record<
  SubagentRun["result"]["progress"]["status"],
  [string, Tone]
> = {
  pending: ["Queued", "dim"],
  running: ["Running", "warning"],
  completed: ["Completed", "success"],
  failed: ["Failed", "error"],
  timed_out: ["Timed out", "warning"],
  stopped: ["Stopped", "muted"],
  interrupted: ["Interrupted", "muted"],
};

function taskTone({ state, job }: TaskRow): Tone {
  switch (state) {
    case "exited":
      return job.exitCode === 0 ? "success" : "error";
    case "failed":
      return "error";
    case "stopped":
    case "interrupted":
      return "muted";
    default:
      return "warning";
  }
}

/**
 * The status in words, with the elapsed time once the item has started, and
 * a subagent's cost once it has one.
 */
export function itemStatus(
  item: Item,
  now = Date.now(),
): { text: string; tone: Tone } {
  if (item.kind === "task") {
    const { row } = item;
    const started = row.job.startedAt !== undefined;
    return {
      text: `${taskStatusLabel(row)}${started ? ` · ${elapsed(row)}` : ""}`,
      tone: taskTone(row),
    };
  }
  const { result, startedAt } = item.run;
  const [word, tone] = AGENT_STATUS[result.progress.status];
  const time =
    result.progress.status === "pending"
      ? undefined
      : result.progress.status === "running" && startedAt !== undefined
        ? now - startedAt
        : result.progress.durationMs;
  // A session row sums the cost of the session's runs.
  const cost =
    result.usage.cost > 0 ? ` · ${formatCost(result.usage.cost)}` : "";
  return {
    text: `${time === undefined ? word : `${word} · ${duration(time)}`}${cost}`,
    tone,
  };
}

/** The job's label or command, or the first line of the subagent's task. */
export function itemTitle(item: Item): string {
  if (item.kind === "task")
    return terminalText(item.row.job.label || item.row.job.command);
  const { result } = item.run;
  const task = (result.task.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  const asks =
    result.question && !isActive(item.run) ? " · asks the parent" : "";
  return `${terminalText(task)}${asks}`;
}

/** The items whose ID starts with the prefix, ignoring case. */
export function matchItems(sections: Sections, prefix: string): Item[] {
  const lower = prefix.toLowerCase();
  return sectionItems(sections).filter((item) =>
    item.id.toLowerCase().startsWith(lower),
  );
}

/** A job ID, a session ID, or a prefix of either. */
export const ITEM_ID_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The one item the prefix names, or why there is none. */
export function resolveItem(
  sections: Sections,
  snapshot: Snapshot | undefined,
  prefix: string,
): { item: Item } | { error: string } {
  const matches = matchItems(sections, prefix);
  const lower = prefix.toLowerCase();
  const unreadable = (snapshot?.errors ?? []).filter((message) =>
    message.toLowerCase().startsWith(lower),
  );
  if (matches.length + unreadable.length > 1)
    return {
      error: "Multiple jobs or subagents match. Enter a longer prefix.",
    };
  if (matches[0]) return { item: matches[0] };
  return {
    error: unreadable[0]
      ? terminalText(unreadable[0])
      : "No such background job or subagent in this session",
  };
}

/** Completion entries for `/tasks`, labeled with their kind. */
export function completions(
  sections: Sections,
  prefix: string,
): { value: string; label: string; description: string }[] {
  const items = matchItems(sections, prefix);
  // Shell jobs first, then subagents, each in view order.
  const ordered = [
    ...items.filter((item) => item.kind === "task"),
    ...items.filter((item) => item.kind === "agent"),
  ];
  return ordered.map((item) => {
    const value =
      item.kind === "task"
        ? item.id.slice(0, Math.max(item.shortId.length, prefix.length))
        : item.id;
    return {
      value,
      label: value,
      description: `${item.kind} · ${itemStatus(item).text} · ${itemTitle(item)}`,
    };
  });
}
