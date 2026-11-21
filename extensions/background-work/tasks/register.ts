import { join, resolve, sep } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { watchTaskFooter } from "./footer.ts";
import { sendTaskNotice } from "./notices.ts";
import { handOver, type JobRegistry, takeOver } from "./registry.ts";
import {
  DEFAULT_TIMEOUT_MS,
  type Job,
  jobDir,
  MAX_TIMER_MS,
  sessionDir,
} from "./runner.ts";
import { taskStatus } from "./status.ts";
import { STOP_WAIT_MS, stopTask, stopText } from "./stop.ts";
import {
  displayJobId,
  interruptedTasks,
  markNoticeSent,
  sessionTasks,
  terminalText,
} from "./task-store.ts";

const storageRoot = () => join(getAgentDir(), "background-tasks");

/** What the background-work view needs from the task feature. */
export interface TasksHandle {
  registry: JobRegistry;
  /** The directory that holds every session's job records. */
  root: () => string;
}

export async function registerTasks(pi: ExtensionAPI): Promise<TasksHandle> {
  // A reload hands over the previous runtime's registry with its jobs.
  const registry = takeOver();
  pi.registerTool({
    name: "task_start",
    label: "Background task",
    description:
      "Submit a non-interactive /bin/sh command to run in the background. Returns a job ID and output log path without waiting for the command to finish. The job stops when Pi exits or the session closes. Requires a saved session.",
    promptSnippet:
      "Start a shell command in the background and return its log path",
    parameters: Type.Object(
      {
        command: Type.String({
          minLength: 1,
          description: "Shell command to run without terminal input.",
        }),
        label: Type.Optional(
          Type.String({ description: "Short name for the job." }),
        ),
        cwd: Type.Optional(
          Type.String({
            description:
              "Working directory, absolute or relative to the session working directory. Defaults to the session working directory.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: MAX_TIMER_MS,
            description: `Maximum runtime in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} (30 minutes). Use 0 only for jobs intended to run until stopped with task_stop.`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted)
        throw new Error("Background task launch was cancelled");
      if (!ctx.sessionManager.getSessionFile()) {
        throw new Error(
          "Background tasks require a saved Pi session, which keeps the job's history and log.",
        );
      }
      const root = storageRoot();
      const sessionId = ctx.sessionManager.getSessionId();
      const { job } = await registry.start(root, sessionId, {
        command: params.command,
        label: params.label,
        cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd,
        timeoutMs: params.timeoutMs === 0 ? null : params.timeoutMs,
      });
      const logPath = join(jobDir(root, sessionId, job.id), "output.log");
      return {
        content: [
          {
            type: "text",
            text: `Submitted background job ${job.id}.\nOutput log: ${logPath}`,
          },
        ],
        details: { jobId: job.id, logPath },
      };
    },
  });

  pi.registerTool({
    name: "task_stop",
    label: "Stop background task",
    description: `Stop a background job of this session by job ID or unique prefix. Waits up to ${STOP_WAIT_MS / 1_000} seconds for the job to end and reports its final state.`,
    promptSnippet: "Stop a background shell command started with task_start",
    parameters: Type.Object(
      {
        jobId: Type.String({
          minLength: 1,
          description: "Job ID from task_start, or a unique prefix of it.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.sessionManager.getSessionFile()) {
        throw new Error("Background tasks require a saved Pi session.");
      }
      const outcome = await stopTask(
        registry,
        storageRoot(),
        ctx.sessionManager.getSessionId(),
        params.jobId,
        { signal },
      );
      return {
        content: [{ type: "text", text: stopText(outcome) }],
        details: { jobId: outcome.job.id, state: outcome.job.state },
      };
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "Background task status",
    description:
      "List the background jobs of this session, or inspect one by job ID or unique prefix. One job includes the last lines of its log. Returns immediately without consuming completion notices. Use on demand, not to poll for results.",
    promptSnippet: "Check the state of background shell commands",
    parameters: Type.Object(
      {
        jobId: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Job ID from task_start, or a unique prefix of it.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.sessionManager.getSessionFile()) {
        throw new Error("Background tasks require a saved Pi session.");
      }
      const jobs = await taskStatus(
        storageRoot(),
        ctx.sessionManager.getSessionId(),
        params.jobId,
      );
      return {
        content: [
          {
            type: "text",
            text: jobs.length
              ? JSON.stringify(jobs, null, 2)
              : "No background jobs in this session.",
          },
        ],
        details: jobs,
      };
    },
  });

  // After shutdown, this runtime's pi and ctx are no longer valid.
  let closed = false;

  // Each notice names the job by its shortest unique ID prefix.
  async function announce(
    rows: Awaited<ReturnType<typeof sessionTasks>>["rows"],
    sessionId: string,
    triggerTurn: boolean,
  ): Promise<void> {
    if (closed) return;
    const snapshot = await sessionTasks(storageRoot(), sessionId);
    if (closed) return;
    sendTaskNotice(
      pi,
      rows.map((row) => ({ row, shortId: displayJobId(row.job.id, snapshot) })),
      triggerTurn,
    );
  }

  let disposers: Array<() => void> = [];
  pi.on("session_start", (_event, ctx) => {
    for (const dispose of disposers) dispose();
    disposers = [];
    const sessionId = ctx.sessionManager.getSessionId();
    const root = storageRoot();
    // Any session's jobs are owned by this process, so only a TUI session
    // announces what ends, and only its own jobs.
    let own: string;
    try {
      own = `${sessionDir(root, sessionId)}${sep}`;
    } catch (error) {
      ctx.ui.notify(
        `Background tasks unavailable for this session: ${terminalText(String(error))}`,
        "error",
      );
      return;
    }
    if (ctx.mode === "tui") {
      disposers.push(watchTaskFooter(ctx.ui, registry));
      disposers.push(
        registry.onEnd((job: Job, dir: string) => {
          if (!dir.startsWith(own)) return;
          const row = { job, state: job.state, dir };
          // A stop was requested on purpose, so it does not wake the agent.
          void announce([row], sessionId, job.state !== "stopped").catch(
            (error: unknown) => {
              if (closed) return;
              ctx.ui.notify(
                `Background task notice failed: ${terminalText(String(error))}`,
                "error",
              );
            },
          );
        }),
      );
    }
    void interruptedTasks(root, sessionId, (id) => registry.owns(id))
      .then(async ({ rows, errors }) => {
        if (closed) return;
        for (const error of errors)
          ctx.ui.notify(
            `Background task record unavailable: ${terminalText(error)}`,
            "warning",
          );
        if (ctx.mode !== "tui" || !rows.length) return;
        await announce(rows, sessionId, false);
        for (const row of rows) markNoticeSent(row);
      })
      .catch((error: unknown) => {
        if (closed) return;
        ctx.ui.notify(
          `Could not check for interrupted background tasks: ${terminalText(String(error))}`,
          "error",
        );
      });
  });
  pi.on("session_shutdown", (event) => {
    closed = true;
    for (const dispose of disposers) dispose();
    disposers = [];
    // A reload keeps the session, so its jobs keep running.
    if (event?.reason === "reload") handOver(registry);
    else registry.stopAll();
  });

  return { registry, root: storageRoot };
}
