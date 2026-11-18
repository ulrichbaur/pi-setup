import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const MAX_TIMER_MS = 2_147_483_647;

export type JobState =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed"
  | "stopped"
  | "timed_out";

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
  socketPath: string;
  createdAt: string;
  state: JobState;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
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

export function sessionDir(root: string, sessionId: string): string {
  if (!isUuid(sessionId)) throw new Error("Invalid Pi session ID");
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

export async function startJob(
  root: string,
  sessionId: string,
  spec: JobSpec,
): Promise<Job> {
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
  // Unix sockets have a short path limit, even when the state directory does not.
  const controlDir = mkdtempSync("/tmp/pi-bg-");
  const job: Job = {
    ...spec,
    id,
    timeoutMs,
    socketPath: join(controlDir, "control.sock"),
    state: "starting",
    createdAt: new Date().toISOString(),
  };
  try {
    saveJob(dir, job);
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./supervisor.ts", import.meta.url)),
        dir,
      ],
      { detached: true, stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return job;
  } catch (error) {
    rmSync(controlDir, { recursive: true, force: true });
    saveJob(dir, {
      ...job,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: String(error),
    });
    throw error;
  }
}

function request(job: Job, action: "status" | "stop"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(job.socketPath);
    const timer = setTimeout(() => finish(false), 500);
    let reply = "";
    function finish(ok: boolean) {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    }
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${job.id} ${action}\n`));
    socket.on("data", (chunk: string) => {
      reply += chunk;
      if (reply.length > 64) finish(false);
    });
    socket.on("close", () => finish(reply === `${job.id} ok\n`));
    socket.on("error", () => finish(false));
  });
}

export async function inspectJob(
  dir: string,
): Promise<{ job: Job; state: JobState | "unknown" }> {
  const job = readJob(dir);
  if (job.finishedAt) return { job, state: job.state };
  const reachable = await request(job, "status");
  const latest = readJob(dir);
  return {
    job: latest,
    state: reachable || latest.finishedAt ? latest.state : "unknown",
  };
}

/** Returns true only if the live supervisor accepted the stop request. */
export async function stopJob(dir: string): Promise<boolean> {
  const job = readJob(dir);
  return !job.finishedAt && request(job, "stop");
}
