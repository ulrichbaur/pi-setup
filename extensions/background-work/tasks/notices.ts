import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TaskRow, terminalText } from "./task-store.ts";

export const NOTICE_TYPE = "background-task-completion";

function outcome({ job, state }: TaskRow): string {
  switch (state) {
    case "exited":
      return job.exitCode === 0 ? "completed" : "failed";
    case "failed":
      return job.startedAt ? "failed" : "failed to start";
    case "timed_out":
      return "timed out";
    case "interrupted":
      return "interrupted when Pi closed";
    default:
      return "stopped";
  }
}

export function noticeText(row: TaskRow, shortId: string): string {
  const { job, dir } = row;
  const label = job.label && terminalText(job.label).trim().slice(0, 120);
  const exit =
    job.signal ?? (job.exitCode == null ? undefined : `exit ${job.exitCode}`);
  return [
    `Background task${label ? ` (${label})` : ""} ${outcome(row)}${exit ? ` · ${exit}` : ""}.`,
    `Details: /tasks ${shortId}`,
    `Output log: ${terminalText(join(dir, "output.log"))}`,
  ].join("\n");
}

/**
 * Sends one notice for the rows. A notice that starts a turn reaches a busy
 * agent before its next model call, or wakes an idle one.
 */
export function sendTaskNotice(
  pi: Pick<ExtensionAPI, "sendMessage">,
  rows: { row: TaskRow; shortId: string }[],
  triggerTurn: boolean,
): void {
  if (!rows.length) return;
  pi.sendMessage(
    {
      customType: NOTICE_TYPE,
      content: rows
        .map(({ row, shortId }) => noticeText(row, shortId))
        .join("\n\n"),
      display: true,
      details: { jobIds: rows.map(({ row }) => row.job.id) },
    },
    { deliverAs: "steer", triggerTurn },
  );
}
