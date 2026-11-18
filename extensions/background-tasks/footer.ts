import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { active, sessionTasks, type TaskRow } from "./task-store.ts";

const KEY = "background-tasks";

export function taskSummary(rows: TaskRow[]): string | undefined {
  let running = 0;
  let unreviewed = 0;
  let failed = 0;
  let unknown = 0;
  for (const row of rows) {
    if (active(row)) running++;
    if (row.state === "unknown") unknown++;
    if (!row.job.finishedAt || row.reviewed) continue;
    unreviewed++;
    if (
      row.state === "failed" ||
      row.state === "timed_out" ||
      (row.state === "exited" && row.job.exitCode !== 0)
    )
      failed++;
  }
  const parts = [];
  if (running) parts.push(`${running} running`);
  if (unreviewed)
    parts.push(
      `${unreviewed} unreviewed${failed ? ` (${failed} failed)` : ""}`,
    );
  if (unknown) parts.push(`${unknown} unknown`);
  return parts.length ? parts.join(" · ") : undefined;
}

export function watchTaskFooter(
  ctx: ExtensionContext,
  root: string,
  publishNotices: (rows: TaskRow[], errors: string[]) => boolean,
): () => void {
  const sessionId = ctx.sessionManager.getSessionId();
  let closed = false;
  let updating = false;
  let previous: string | undefined;

  async function refresh(): Promise<void> {
    if (closed || updating) return;
    updating = true;
    let text: string | undefined;
    try {
      const { rows, errors } = await sessionTasks(root, sessionId);
      if (closed) return;
      const noticesOk = publishNotices(rows, errors);
      text =
        [
          taskSummary(rows),
          errors.length ? "some tasks unavailable" : undefined,
          noticesOk ? undefined : "some notices unavailable",
        ]
          .filter(Boolean)
          .join(" · ") || undefined;
    } catch {
      text = "tasks unavailable";
    } finally {
      updating = false;
    }
    if (!closed && previous !== text) {
      previous = text;
      ctx.ui.setStatus(KEY, text);
    }
  }

  const timer = setInterval(() => void refresh(), 1_000);
  timer.unref();
  void refresh();
  return () => {
    closed = true;
    clearInterval(timer);
    if (previous !== undefined) ctx.ui.setStatus(KEY, undefined);
  };
}
