import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJob, type Job, type JobSpec, saveJob } from "./runner.ts";
import type { WorkerEvent } from "./worker.ts";

const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));

type StopReason = "stopped" | "timed_out";

interface LiveJob {
  dir: string;
  job: Job;
  worker: ChildProcess;
  timer?: NodeJS.Timeout;
  stopReason?: StopReason;
  outcome?: Pick<Job, "exitCode" | "signal">;
  finished: boolean;
}

export type JobListener = (job: Job, dir: string) => void;

/**
 * The jobs this Pi process runs. Each job has a worker that stops the job's
 * process group on request; when Pi exits, the worker stops the group and
 * records the end.
 */
export class JobRegistry {
  private readonly live = new Map<string, LiveJob>();
  private readonly listeners = new Set<JobListener>();

  async start(
    root: string,
    sessionId: string,
    spec: JobSpec,
  ): Promise<{ job: Job; dir: string }> {
    const { job, dir } = createJob(root, sessionId, spec);
    const worker = spawn(
      process.execPath,
      ["--experimental-strip-types", WORKER, dir],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const entry: LiveJob = { dir, job, worker, finished: false };
    this.live.set(job.id, entry);
    worker.on("error", () => {
      // A failed spawn rejects below; any later failure ends in the exit event.
    });
    worker.on("message", (event: WorkerEvent) => this.onEvent(entry, event));
    // A worker that exits before Pi records the end failed.
    worker.on("exit", (exitCode, signal) => {
      this.finish(entry, "failed", {
        ...entry.outcome,
        error: `The job worker ended unexpectedly (${signal ?? `exit ${exitCode}`})`,
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("spawn", resolve);
        worker.once("error", reject);
      });
    } catch (error) {
      this.finish(entry, "failed", { error: String(error) });
      throw error;
    }
    // Running jobs must not keep Pi from exiting.
    worker.unref();
    worker.channel?.unref();
    this.update(entry, { workerPid: worker.pid });
    return { job: entry.job, dir };
  }

  /** Asks the worker to stop; false when the job is not running here. */
  stop(id: string, reason: StopReason = "stopped"): boolean {
    const entry = this.live.get(id);
    if (!entry || entry.finished || !entry.worker.connected) return false;
    if (entry.stopReason) return true;
    entry.stopReason = reason;
    clearTimeout(entry.timer);
    this.update(entry, { state: "stopping" });
    entry.worker.send("stop", () => {});
    return true;
  }

  stopAll(): void {
    for (const id of this.live.keys()) this.stop(id);
  }

  owns(id: string): boolean {
    return this.live.has(id);
  }

  /** The jobs that have not ended, oldest first. */
  active(): Job[] {
    return [...this.live.values()].map((entry) => entry.job);
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the job once it ends, or undefined after `waitMs`. */
  waitForEnd(
    id: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<Job | undefined> {
    const entry = this.live.get(id);
    if (!entry) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const finish = (job?: Job) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        resolve(job);
      };
      const abort = () => finish();
      const timer = setTimeout(abort, waitMs).unref();
      const unsubscribe = this.subscribe((job) => {
        if (job.id === id && job.finishedAt) finish(job);
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private onEvent(entry: LiveJob, event: WorkerEvent): void {
    switch (event.type) {
      case "started": {
        this.update(entry, {
          state: entry.stopReason ? "stopping" : "running",
          startedAt: new Date().toISOString(),
        });
        const { timeoutMs } = entry.job;
        if (!entry.stopReason && timeoutMs !== null) {
          entry.timer = setTimeout(
            () => this.stop(entry.job.id, "timed_out"),
            timeoutMs,
          ).unref();
        }
        break;
      }
      case "exited":
        entry.outcome = { exitCode: event.exitCode, signal: event.signal };
        if (!entry.stopReason) this.finish(entry, "exited", entry.outcome);
        break;
      case "error":
        if (!entry.stopReason)
          this.finish(entry, "failed", { error: event.error });
        break;
      case "stopped":
        this.finish(entry, entry.stopReason ?? "stopped", entry.outcome);
        break;
    }
  }

  private finish(
    entry: LiveJob,
    state: Job["state"],
    details: Partial<Job> = {},
  ): void {
    if (entry.finished) return;
    entry.finished = true;
    clearTimeout(entry.timer);
    this.live.delete(entry.job.id);
    // A released worker leaves children the shell left behind running.
    if (entry.worker.connected) entry.worker.send("release", () => {});
    this.update(entry, {
      ...details,
      state,
      finishedAt: new Date().toISOString(),
    });
  }

  private update(entry: LiveJob, changes: Partial<Job>): void {
    entry.job = { ...entry.job, ...changes };
    try {
      saveJob(entry.dir, entry.job);
    } catch (error) {
      // The job goes on; its record on disk keeps the last saved state.
      entry.job.error ??= `Could not save the job record: ${String(error)}`;
    }
    for (const listener of this.listeners) listener(entry.job, entry.dir);
  }
}

/**
 * Raise this when the JobRegistry's methods or fields change. A reload then
 * stops the old runtime's jobs instead of handing them to code that may not
 * fit them.
 */
export const REGISTRY_VERSION = 1;
const HANDOVER = Symbol.for("pi-setup/background-work/job-registry");
type Handover = { version?: number; registry?: Partial<JobRegistry> };
const slots = globalThis as Record<symbol, Handover | undefined>;

/** Keeps the registry, and its running jobs, for the runtime a reload loads. */
export function handOver(registry: JobRegistry): void {
  slots[HANDOVER] = { version: REGISTRY_VERSION, registry };
}

/** The registry a reload handed over, or a new one. */
export function takeOver(): JobRegistry {
  const slot = slots[HANDOVER];
  delete slots[HANDOVER];
  if (slot?.registry && slot.version === REGISTRY_VERSION)
    return slot.registry as JobRegistry;
  slot?.registry?.stopAll?.();
  return new JobRegistry();
}
