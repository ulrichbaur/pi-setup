import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Job, readJob, saveJob } from "./runner.ts";
import type { WorkerEvent } from "./worker.ts";

function supervise(dir: string): void {
  let job = readJob(dir);
  let timer: NodeJS.Timeout | undefined;
  let worker: ChildProcess | undefined;
  let stopReason: "stopped" | "timed_out" | undefined;
  let outcome: Pick<Job, "exitCode" | "signal"> | undefined;
  let closing = false;

  function log(event: string, details: object = {}, level = "info") {
    try {
      appendFileSync(
        join(dir, "supervisor.jsonl"),
        `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...details })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Diagnostic failures must not prevent writing job state or stopping the worker.
    }
  }

  function update(changes: Partial<Job>) {
    const next = { ...job, ...changes };
    saveJob(dir, next);
    job = next;
  }

  function close() {
    closing = true;
    clearTimeout(timer);
    server.close(() =>
      rmSync(dirname(job.socketPath), { recursive: true, force: true }),
    );
  }

  function finish(state: Job["state"], details: Partial<Job> = {}) {
    if (closing) return;
    try {
      update({ ...details, state, finishedAt: new Date().toISOString() });
      log("job_finished", {
        state,
        exitCode: job.exitCode,
        signal: job.signal,
      });
    } catch (error) {
      log("job_save_failed", { error: String(error) }, "error");
    }
    if (worker?.connected) worker.send("release", () => {});
    close();
  }

  function stop(reason: "stopped" | "timed_out"): boolean {
    if (closing || !worker?.connected) return false;
    if (stopReason) return true;
    stopReason = reason;
    clearTimeout(timer);
    try {
      update({ state: "stopping" });
    } catch (error) {
      log("job_save_failed", { error: String(error) }, "error");
    }
    log("stop_requested", { reason });
    worker.send("stop", (error) => {
      if (error) log("stop_delivery_failed", { error: error.message }, "error");
    });
    return true;
  }

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.setTimeout(500, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (request.length > 64) socket.destroy();
    });
    socket.on("end", () => {
      const accepted =
        !closing &&
        (request === `${job.id} status\n` ||
          (request === `${job.id} stop\n` && stop("stopped")));
      socket.end(accepted ? `${job.id} ok\n` : "");
    });
  });

  log("supervisor_started");
  server.on("error", (error) => {
    log("socket_failed", { error: error.message }, "error");
    if (!worker) finish("failed", { error: error.message });
  });
  server.listen(job.socketPath, () => {
    worker = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./worker.ts", import.meta.url)),
        dir,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    worker.on("message", (event: WorkerEvent) => {
      switch (event.type) {
        case "started":
          try {
            update({
              state: stopReason ? "stopping" : "running",
              startedAt: new Date().toISOString(),
            });
          } catch (error) {
            log("job_save_failed", { error: String(error) }, "error");
          }
          log("command_started");
          if (!stopReason && job.timeoutMs !== null)
            timer = setTimeout(() => stop("timed_out"), job.timeoutMs);
          break;
        case "exited":
          outcome = { exitCode: event.exitCode, signal: event.signal };
          log("command_exited", outcome);
          if (!stopReason) finish("exited", outcome);
          break;
        case "error":
          log("command_spawn_failed", { error: event.error }, "error");
          if (!stopReason) finish("failed", { error: event.error });
          break;
      }
    });
    worker.on("error", (error) => {
      log("worker_error", { error: error.message }, "error");
      if (!worker?.pid) finish("failed", { error: error.message });
    });
    worker.on("exit", (exitCode, signal) => {
      if (closing) return;
      if (stopReason && signal === "SIGKILL") {
        log("worker_killed", { signal });
        finish(stopReason, outcome);
      } else {
        // Without a confirmed outcome, leave the record nonterminal and report unknown.
        log("worker_lost", { exitCode, signal }, "error");
        close();
      }
    });
  });
}

supervise(process.argv[2]);
