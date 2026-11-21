import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { readJob, saveJob } from "./runner.ts";

export type WorkerEvent =
  | { type: "started" }
  | { type: "exited"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { type: "error"; error: string };

const STOP_GRACE_MS = 5_000;

function run(dir: string): void {
  if (!process.send)
    throw new Error("The job worker requires an IPC channel to Pi");
  // Pi may be gone. A send then fails, which the callback absorbs, and the
  // disconnect handler takes over.
  const send = (event: WorkerEvent) => {
    if (process.connected) process.send?.(event, undefined, {}, () => {});
  };
  const job = readJob(dir);
  let stopping = false;
  let released = false;
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

  // The worker is the process-group leader and stays alive through escalation.
  // It signals its own group, so it never targets a reused PID or group ID.
  process.on("SIGTERM", () => {});
  function stop() {
    if (stopping) return;
    stopping = true;
    process.kill(0, "SIGTERM");
    setTimeout(() => process.kill(0, "SIGKILL"), STOP_GRACE_MS);
  }
  process.on("message", (msg) => {
    if (msg === "stop") stop();
    if (msg === "release" && !stopping) {
      released = true;
      process.disconnect?.();
    }
  });
  process.on("disconnect", () => {
    if (released) return;
    recordEnd();
    stop();
  });

  try {
    const output = openSync(join(dir, "output.log"), "a", 0o600);
    try {
      const shell = spawn("/bin/sh", ["-c", job.command], {
        cwd: job.cwd,
        stdio: ["ignore", output, output],
      });
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
