import type { JobRegistry } from "./registry.ts";
import { type Job, readJob } from "./runner.ts";
import { exitText } from "./status.ts";
import { findTask, JOB_ID_PREFIX, sessionTasks } from "./task-store.ts";

/** Covers the worker's grace period before it sends SIGKILL, plus a margin. */
export const STOP_WAIT_MS = 7_000;

export interface StopOutcome {
  job: Job;
  /** True when the job had finished before the stop request. */
  alreadyEnded: boolean;
}

export function stopText({ job, alreadyEnded }: StopOutcome): string {
  if (alreadyEnded)
    return `Background job ${job.id} had already ended: ${job.state}${exitText(job)}.`;
  if (!job.finishedAt)
    return `Stop requested for background job ${job.id}. It is still stopping. A notice follows when it ends.`;
  if (job.state === "stopped")
    return `Stopped background job ${job.id}${exitText(job)}.`;
  return `Background job ${job.id} ended before the stop took effect: ${job.state}${exitText(job)}.`;
}

/**
 * Stops a job of the session and waits until it ends or `waitMs` passes.
 * An abort of `signal` ends the wait, not the stop.
 */
export async function stopTask(
  registry: JobRegistry,
  root: string,
  sessionId: string,
  jobId: string,
  { signal, waitMs = STOP_WAIT_MS }: { signal?: AbortSignal; waitMs?: number },
): Promise<StopOutcome> {
  const prefix = jobId.trim().toLowerCase();
  if (!JOB_ID_PREFIX.test(prefix))
    throw new Error(`Invalid background job ID: ${jobId}`);
  const found = findTask(await sessionTasks(root, sessionId), prefix);
  if ("error" in found) throw new Error(found.error);
  const { row } = found;
  if (row.job.finishedAt) return { job: row.job, alreadyEnded: true };
  const { id } = row.job;
  const ended = registry.waitForEnd(id, waitMs, signal);
  if (!registry.stop(id)) {
    const job = readJob(row.dir);
    if (job.finishedAt) return { job, alreadyEnded: false };
    throw new Error(
      `Background job ${id} is not running in this Pi process, so it cannot be stopped here.`,
    );
  }
  return { job: (await ended) ?? readJob(row.dir), alreadyEnded: false };
}
