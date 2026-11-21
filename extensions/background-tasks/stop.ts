import { setTimeout as delay } from "node:timers/promises";
import { type Job, readJob, stopJob } from "./runner.ts";
import { findTask, JOB_ID_PREFIX, sessionTasks } from "./task-store.ts";

/** Covers the worker's grace period before it sends SIGKILL, plus a margin. */
export const STOP_WAIT_MS = 7_000;
const POLL_MS = 200;

export interface StopOutcome {
  job: Job;
  /** True when the job had finished before the stop request. */
  alreadyEnded: boolean;
}

function exitText(job: Job): string {
  const exit =
    job.signal ?? (job.exitCode == null ? undefined : `exit ${job.exitCode}`);
  return exit ? ` (${exit})` : "";
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
  if (row.state === "unknown") {
    throw new Error(
      `Could not reach the supervisor of background job ${row.job.id}. Its state is unknown.`,
    );
  }
  if (!(await stopJob(row.dir))) {
    const job = readJob(row.dir);
    if (job.finishedAt) return { job, alreadyEnded: false };
    throw new Error(
      `Background job ${row.job.id} did not accept the stop request.`,
    );
  }
  const deadline = Date.now() + waitMs;
  let job = readJob(row.dir);
  while (!job.finishedAt && Date.now() < deadline && !signal?.aborted) {
    await delay(Math.min(POLL_MS, deadline - Date.now()));
    job = readJob(row.dir);
  }
  return { job, alreadyEnded: false };
}
