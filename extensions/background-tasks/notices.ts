import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { displayJobId, type TaskRow, terminalText } from "./task-store.ts";

export const NOTICE_TYPE = "background-task-completion";

function describe({ job, dir }: TaskRow, id: string): string {
  const outcome =
    job.state === "exited"
      ? job.exitCode === 0
        ? "completed"
        : "failed"
      : job.state === "failed"
        ? "failed to start"
        : job.state === "timed_out"
          ? "timed out"
          : "stopped";
  const exit =
    job.signal ?? (job.exitCode == null ? undefined : `exit ${job.exitCode}`);
  const label = job.label && terminalText(job.label).trim().slice(0, 120);
  return [
    `Background task${label ? ` (${label})` : ""} ${outcome}${exit ? ` · ${exit}` : ""}.`,
    `Details: /tasks ${id}`,
    `Output log: ${terminalText(join(dir, "output.log"))}`,
  ].join("\n");
}

export function createTaskNotices(
  pi: Pick<ExtensionAPI, "sendMessage">,
  openedAt: number,
) {
  const seen = new Set<string>();
  return (rows: TaskRow[], errors: string[] = []): boolean => {
    const passive: TaskRow[] = [];
    const live: TaskRow[] = [];
    let success = true;
    for (const row of rows) {
      const { id, finishedAt, state } = row.job;
      if (!finishedAt || seen.has(id)) continue;
      try {
        // Exclusive creation prevents concurrent viewers from announcing the same job.
        writeFileSync(join(row.dir, "notified"), "", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") seen.add(id);
        else success = false;
        continue;
      }
      seen.add(id);
      if (state === "stopped" || !(Date.parse(finishedAt) > openedAt))
        passive.push(row);
      else live.push(row);
    }
    for (const [batch, triggerTurn] of [
      [passive, false],
      [live, true],
    ] as const) {
      if (!batch.length) continue;
      pi.sendMessage(
        {
          customType: NOTICE_TYPE,
          content: batch
            .map((row) =>
              describe(row, displayJobId(row.job.id, { rows, errors })),
            )
            .join("\n\n"),
          display: true,
          details: { jobIds: batch.map((row) => row.job.id) },
        },
        { deliverAs: "steer", triggerTurn },
      );
    }
    return success;
  };
}
