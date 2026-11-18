import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { readJob } from "./runner.ts";

export type WorkerEvent =
  | { type: "started" }
  | { type: "exited"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { type: "error"; error: string };

const STOP_GRACE_MS = 5_000;

function run(dir: string): void {
  const send = process.send?.bind(process);
  if (!send)
    throw new Error("The job worker requires a supervisor IPC channel");
  const job = readJob(dir);
  let stopping = false;
  let released = false;

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
    if (!released) stop();
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
      shell.once("exit", (exitCode, signal) =>
        send({ type: "exited", exitCode, signal } satisfies WorkerEvent),
      );
    } finally {
      closeSync(output);
    }
  } catch (error) {
    send({ type: "error", error: String(error) } satisfies WorkerEvent);
  }
}

run(process.argv[2]);
