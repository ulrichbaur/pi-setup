import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMER_MS,
} from "../../../lib/background-timeout.ts";

export { DEFAULT_TIMEOUT_MS, MAX_TIMER_MS };

export type JobState =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed"
  | "stopped"
  | "timed_out"
  // Pi ended before it recorded the job's end.
  | "interrupted";

export interface JobSpec {
  command: string;
  cwd: string;
  label?: string;
  /** null disables the runtime limit. */
  timeoutMs?: number | null;
}

export interface Job {
  id: string;
  command: string;
  cwd: string;
  label?: string;
  timeoutMs: number | null;
  createdAt: string;
  state: JobState;
  workerPid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  // Set once Pi has announced an interrupted job.
  noticeSent?: boolean;
}

export function readJob(dir: string): Job {
  return JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
}

export function saveJob(dir: string, job: Job): void {
  const temp = join(dir, `job-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, join(dir, "job.json"));
}

// Pi's own rule for session IDs. It allows no path separator, so the ID
// stays a single folder below the root.
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function sessionDir(root: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error("Invalid Pi session ID");
  return resolve(root, sessionId);
}

function isUuid(id: string): boolean {
  return (
    id.length === 36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
  );
}

export const isJobId = isUuid;

export function jobDir(root: string, sessionId: string, id: string): string {
  if (!isJobId(id)) throw new Error("Invalid background job ID");
  return join(sessionDir(root, sessionId), id);
}

/** Validates the spec and writes the record of a job that has not started. */
export function createJob(
  root: string,
  sessionId: string,
  spec: JobSpec,
): { job: Job; dir: string } {
  if (process.platform === "win32")
    throw new Error("Background jobs require a Unix-like OS");
  if (!sessionId || !spec.command.trim() || !isAbsolute(spec.cwd)) {
    throw new Error(
      "Background jobs require a session ID, a command, and an absolute cwd",
    );
  }
  const timeoutMs =
    spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : spec.timeoutMs;
  if (
    timeoutMs !== null &&
    (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS)
  ) {
    throw new Error(
      `timeoutMs must be null or an integer between 1 and ${MAX_TIMER_MS}`,
    );
  }
  const id = randomUUID();
  const dir = jobDir(root, sessionId, id);
  mkdirSync(sessionDir(root, sessionId), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  const job: Job = {
    ...spec,
    id,
    timeoutMs,
    state: "starting",
    createdAt: new Date().toISOString(),
  };
  saveJob(dir, job);
  return { job, dir };
}
