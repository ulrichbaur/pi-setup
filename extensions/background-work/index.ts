import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerGuards, runningWork } from "./guard.ts";
import {
  buildSections,
  completions,
  ITEM_ID_PREFIX,
  resolveItem,
  type Snapshot,
} from "./rows.ts";
import {
  registerSubagents,
  type SubagentsHandle,
} from "./subagents/register.ts";
import { sessionRows } from "./subagents/session-view.ts";
import { registerTasks, type TasksHandle } from "./tasks/register.ts";
import { sessionTasks, terminalText } from "./tasks/task-store.ts";
import { BackgroundView, type ViewSources } from "./view.ts";

/**
 * Registers one feature. A failure is reported when a session starts and
 * leaves the other features working.
 */
async function registerFeature<T>(
  pi: ExtensionAPI,
  name: string,
  unavailable: string[],
  register: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await register();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    unavailable.push(`${name} unavailable: ${message}`);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`${name} not loaded: ${message}`, "error");
    });
    return undefined;
  }
}

/** Background shell tasks and subagents, shown together by /tasks. */
export default async function backgroundWork(pi: ExtensionAPI): Promise<void> {
  const unavailable: string[] = [];
  const tasks = await registerFeature<TasksHandle>(
    pi,
    "Background tasks",
    unavailable,
    () => registerTasks(pi),
  );
  const subagents = await registerFeature<SubagentsHandle>(
    pi,
    "Subagents",
    unavailable,
    () => registerSubagents(pi),
  );

  const sources = (sessionId: string): ViewSources => ({
    ...(tasks && {
      tasks: {
        registry: tasks.registry,
        load: () => sessionTasks(tasks.root(), sessionId),
      },
    }),
    ...(subagents && { subagents }),
    unavailable,
  });
  const snapshotOf = async (view: ViewSources): Promise<Snapshot | undefined> =>
    view.tasks?.load();
  const sectionsOf = (view: ViewSources, snapshot: Snapshot | undefined) =>
    buildSections(
      snapshot,
      view.subagents ? sessionRows(view.subagents.registry.list()) : undefined,
    );

  async function openView(args: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/tasks requires interactive mode", "error");
      return;
    }
    const prefix = args.trim();
    if (prefix && !ITEM_ID_PREFIX.test(prefix)) {
      ctx.ui.notify(
        "Usage: /tasks [job ID, subagent session ID, or a unique prefix]",
        "error",
      );
      return;
    }
    const view = sources(ctx.sessionManager.getSessionId());
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await snapshotOf(view);
    } catch (error) {
      // The shell section shows the error; subagents still list.
      view.unavailable = [
        ...view.unavailable,
        `Shell tasks unavailable: ${terminalText(String(error))}`,
      ];
    }
    let component: BackgroundView | undefined;
    try {
      let openKey: string | undefined;
      if (prefix) {
        const found = resolveItem(sectionsOf(view, snapshot), snapshot, prefix);
        if ("error" in found) {
          ctx.ui.notify(found.error, "error");
          return;
        }
        openKey = found.item.key;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) => {
          component = new BackgroundView(
            tui,
            theme,
            keys,
            done,
            view,
            snapshot,
            openKey,
          );
          return component;
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
      component?.dispose();
    }
  }

  let completionSession: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    completionSession =
      ctx.mode === "tui" ? ctx.sessionManager.getSessionId() : undefined;
  });
  pi.on("session_shutdown", () => {
    completionSession = undefined;
  });

  pi.registerCommand("tasks", {
    description:
      "View background jobs and subagents, or open one by ID or unique prefix",
    async getArgumentCompletions(input) {
      const sessionId = completionSession;
      const prefix = input.trimStart();
      if (!sessionId || (prefix && !ITEM_ID_PREFIX.test(prefix))) return null;
      const view = sources(sessionId);
      const snapshot = await snapshotOf(view).catch(() => undefined);
      if (completionSession !== sessionId) return null;
      const items = completions(sectionsOf(view, snapshot), prefix);
      return items.length ? items : null;
    },
    handler: openView,
  });

  registerGuards(pi, () => runningWork(tasks, subagents));

  pi.registerShortcut("alt+t", {
    description: "Open background jobs and subagents for this session",
    handler: (ctx) => openView("", ctx),
  });
}
