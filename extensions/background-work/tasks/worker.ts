import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJob, saveJob } from "./runner.ts";

export type WorkerEvent =
  | { type: "started" }
  | { type: "exited"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { type: "error"; error: string }
  // After a stop: no process of the job is left.
  | { type: "stopped" };

const STOP_GRACE_MS = 5_000;
const POLL_MS = 50;

/** Whether any process of the group is left, zombies included. */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // The group ended in the meantime.
  }
}

function run(dir: string): void {
  if (!process.send)
    throw new Error("The job worker requires an IPC channel to Pi");
  // Pi may be gone. A send then fails, which the callback absorbs, and the
  // disconnect handler takes over.
  const send = (event: WorkerEvent, then?: () => void) => {
    if (process.connected) process.send?.(event, undefined, {}, () => then?.());
    else then?.();
  };
  const job = readJob(dir);
  let group: number | undefined;
  let stopping = false;
  let released = false;
  // Set by SIGTERM: the worker then records the end itself.
  let terminated = false;
  let exit:
    | Pick<Extract<WorkerEvent, { type: "exited" }>, "exitCode" | "signal">
    | undefined;

  // Pi records the end of a job it owns. Once Pi is gone, the worker does.
  function recordEnd() {
    try {
      const latest = readJob(dir);
      if (latest.finishedAt) return;
      saveJob(dir, {
        ...latest,
        // A shell that ended on its own exited; one Pi was stopping, or
        // that still runs, was interrupted when Pi closed.
        ...(exit && !stopping
          ? { state: "exited", exitCode: exit.exitCode, signal: exit.signal }
          : { state: "interrupted" }),
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // The record stays unfinished; Pi marks it interrupted on its next start.
    }
  }

  function done() {
    if (terminated) recordEnd();
    send({ type: "stopped" }, () => process.exit(0));
  }

  /**
   * The shell leads its own process group. The worker stops signalling as
   * soon as the group is empty, so it never targets a reused group ID.
   */
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (group === undefined) return done();
    signalGroup(group, "SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (groupAlive(group) && Date.now() < deadline) await delay(POLL_MS);
    if (groupAlive(group)) {
      signalGroup(group, "SIGKILL");
      while (groupAlive(group)) await delay(POLL_MS);
    }
    done();
  }

  // At a system shutdown, Pi may die before it records the end, and the
  // worker's PID may belong to another process after the reboot.
  process.on("SIGTERM", () => {
    terminated = true;
    void stop();
  });

  process.on("message", (msg) => {
    if (msg === "stop") void stop();
    if (msg === "release" && !stopping) {
      released = true;
      process.disconnect?.();
    }
  });
  process.on("disconnect", () => {
    if (released) return;
    recordEnd();
    void stop();
  });

  try {
    const output = openSync(join(dir, "output.log"), "a", 0o600);
    try {
      const shell = spawn("/bin/sh", ["-c", job.command], {
        cwd: job.cwd,
        detached: true,
        stdio: ["ignore", output, output],
      });
      group = shell.pid;
      shell.once("spawn", () =>
        send({ type: "started" } satisfies WorkerEvent),
      );
      shell.once("error", (error) =>
        send({ type: "error", error: error.message } satisfies WorkerEvent),
      );
      shell.once("exit", (exitCode, signal) => {
        exit = { exitCode, signal };
        send({ type: "exited", exitCode, signal } satisfies WorkerEvent);
      });
    } finally {
      closeSync(output);
    }
  } catch (error) {
    send({ type: "error", error: String(error) } satisfies WorkerEvent);
  }
}

run(process.argv[2]);
