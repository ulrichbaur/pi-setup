import { join, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadShortcut } from "./config.ts";
import { watchTaskFooter } from "./footer.ts";
import { createTaskNotices } from "./notices.ts";
import {
  DEFAULT_TIMEOUT_MS,
  jobDir,
  MAX_TIMER_MS,
  startJob,
} from "./runner.ts";
import { displayJobId, sessionTasks, terminalText } from "./task-store.ts";
import { TaskView, taskStatusLabel } from "./task-view.ts";

const storageRoot = () => join(getAgentDir(), "background-tasks");

export default async function backgroundTasks(pi: ExtensionAPI): Promise<void> {
  pi.registerTool({
    name: "task_start",
    label: "Background task",
    description:
      "Submit a non-interactive /bin/sh command that can outlive the Pi process. Returns a job ID and output log path without waiting for the command to finish. Requires a saved session.",
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
            description: `Maximum runtime in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} (30 minutes). Use 0 only for jobs intended to run until stopped.`,
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
          "Background tasks require a saved Pi session so you can recover the job after Pi exits.",
        );
      }
      const root = storageRoot();
      const sessionId = ctx.sessionManager.getSessionId();
      const job = await startJob(root, sessionId, {
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

  async function openTasks(args: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/tasks requires interactive mode", "error");
      return;
    }
    const prefix = args.trim().toLowerCase();
    if (prefix && !/^[0-9a-f][0-9a-f-]{0,35}$/.test(prefix)) {
      ctx.ui.notify("Usage: /tasks [job ID or unique prefix]", "error");
      return;
    }
    const root = storageRoot();
    const sessionId = ctx.sessionManager.getSessionId();
    const load = () => sessionTasks(root, sessionId);
    let view: TaskView | undefined;
    try {
      const snapshot = await load();
      let id: string | undefined;
      if (prefix) {
        const matches = snapshot.rows.filter((row) =>
          row.job.id.startsWith(prefix),
        );
        const errors = snapshot.errors.filter((message) =>
          message.startsWith(prefix),
        );
        if (matches.length + errors.length > 1) {
          ctx.ui.notify(
            "Multiple jobs match. Enter a longer job ID prefix.",
            "error",
          );
          return;
        }
        id = matches[0]?.job.id;
        if (!id) {
          ctx.ui.notify(
            errors[0]
              ? terminalText(errors[0])
              : "No such background job in this session",
            "error",
          );
          return;
        }
      }
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) => {
          view = new TaskView(tui, theme, keys, done, load, snapshot, id);
          return view;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", margin: 1 },
        },
      );
    } catch (error) {
      ctx.ui.notify(
        `Could not open /tasks: ${terminalText(String(error))}`,
        "error",
      );
    } finally {
      view?.dispose();
    }
  }

  let completionSession: { id: string } | undefined;
  pi.registerCommand("tasks", {
    description:
      "View background jobs for this session, or open one by ID or unique prefix",
    async getArgumentCompletions(input) {
      const session = completionSession;
      const prefix = input.trimStart().toLowerCase();
      if (!session || !/^[0-9a-f-]{0,36}$/.test(prefix)) return null;
      const snapshot = await sessionTasks(storageRoot(), session.id).catch(
        () => undefined,
      );
      if (!snapshot || completionSession !== session) return null;
      const items = snapshot.rows
        .filter(({ job }) => job.id.startsWith(prefix))
        .map((row) => {
          const shortId = displayJobId(row.job.id, snapshot);
          const value = row.job.id.slice(
            0,
            Math.max(shortId.length, prefix.length),
          );
          const label = terminalText(row.job.label || row.job.command);
          return {
            value,
            label: value,
            description: `${taskStatusLabel(row)} · ${label}`,
          };
        });
      return items.length ? items : null;
    },
    handler: openTasks,
  });

  let disposeFooter: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    disposeFooter?.();
    completionSession =
      ctx.mode === "tui"
        ? { id: ctx.sessionManager.getSessionId() }
        : undefined;
    disposeFooter =
      ctx.mode === "tui"
        ? watchTaskFooter(ctx, storageRoot(), createTaskNotices(pi, Date.now()))
        : undefined;
  });
  pi.on("session_shutdown", () => {
    completionSession = undefined;
    disposeFooter?.();
    disposeFooter = undefined;
  });

  try {
    const shortcut = await loadShortcut(
      join(getAgentDir(), "background-tasks.json"),
    );
    if (shortcut) {
      pi.registerShortcut(shortcut, {
        description: "Open background tasks for this session",
        handler: (ctx) => openTasks("", ctx),
      });
    }
  } catch (error) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `Background task shortcut not loaded: ${terminalText(String(error))}`,
        "error",
      );
    });
  }
}
