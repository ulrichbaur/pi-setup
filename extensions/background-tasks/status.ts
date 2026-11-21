import { join } from "node:path";
import type { Job } from "./runner.ts";
import {
  findTask,
  JOB_ID_PREFIX,
  readLogPage,
  sessionTasks,
  type TaskRow,
  terminalText,
} from "./task-store.ts";

const COMMAND_CHARS = 200;
const TAIL_LINES = 20;
const TAIL_CHARS = 4_000;

/** The signal or exit code of a finished job, in parentheses. */
export function exitText(job: Job): string {
  const exit =
    job.signal ?? (job.exitCode == null ? undefined : `exit ${job.exitCode}`);
  return exit ? ` (${exit})` : "";
}

export interface JobStatus {
  jobId: string;
  label?: string;
  command?: string;
  state: string;
  exitCode?: number;
  signal?: string;
  error?: string;
  elapsedMs?: number;
  timeoutMs?: number | null;
  logPath?: string;
  outputTail?: string;
}

export function jobStatus(
  { job, state, dir }: TaskRow,
  now: number,
): JobStatus {
  const startedAt = job.startedAt ? Date.parse(job.startedAt) : undefined;
  const endedAt = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const finished = Boolean(job.finishedAt);
  return {
    jobId: job.id,
    ...(job.label && { label: terminalText(job.label) }),
    command: terminalText(job.command).slice(0, COMMAND_CHARS),
    state,
    ...(finished && job.exitCode != null && { exitCode: job.exitCode }),
    ...(finished && job.signal && { signal: job.signal }),
    ...(finished && job.error && { error: terminalText(job.error) }),
    ...(startedAt !== undefined && {
      elapsedMs: Math.max(0, endedAt - startedAt),
    }),
    timeoutMs: job.timeoutMs,
    logPath: join(dir, "output.log"),
  };
}

/** The last lines of a job's log, or why they could not be read. */
export async function outputTail(dir: string): Promise<string> {
  try {
    const { lines } = await readLogPage(dir);
    return lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
  } catch (error) {
    return `Log unavailable: ${terminalText(String(error))}`;
  }
}

/** An unreadable job record keeps its place in the list, with the error. */
function unreadable(message: string): JobStatus {
  const split = message.indexOf(": ");
  return {
    jobId: split < 0 ? message : message.slice(0, split),
    state: "unreadable",
    error: terminalText(split < 0 ? message : message.slice(split + 2)),
  };
}

/** All jobs of the session, or one job with its output tail. */
export async function taskStatus(
  root: string,
  sessionId: string,
  jobId?: string,
): Promise<JobStatus[]> {
  const snapshot = await sessionTasks(root, sessionId);
  const now = Date.now();
  if (jobId === undefined) {
    return [
      ...snapshot.rows.map((row) => jobStatus(row, now)),
      ...snapshot.errors.map(unreadable),
    ];
  }
  const prefix = jobId.trim().toLowerCase();
  if (!JOB_ID_PREFIX.test(prefix))
    throw new Error(`Invalid background job ID: ${jobId}`);
  const found = findTask(snapshot, prefix);
  if ("error" in found) throw new Error(found.error);
  return [
    {
      ...jobStatus(found.row, now),
      outputTail: await outputTail(found.row.dir),
    },
  ];
}
