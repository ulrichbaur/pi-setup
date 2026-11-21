import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentsHandle } from "./subagents/register.ts";
import { isActive } from "./subagents/runs.ts";
import type { TasksHandle } from "./tasks/register.ts";

const TITLE = "Background work is running";

/** Running or queued shell jobs and background subagents. */
export function runningWork(
  tasks: TasksHandle | undefined,
  subagents: SubagentsHandle | undefined,
): { jobs: number; subagents: number } {
  return {
    jobs: tasks?.registry.active().length ?? 0,
    subagents:
      subagents?.registry
        .list()
        .filter((run) => run.result.runId && isActive(run)).length ?? 0,
  };
}

/** For example "2 shell jobs and 1 subagent"; empty when nothing runs. */
export function workText(work: { jobs: number; subagents: number }): string {
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  return [
    work.jobs ? plural(work.jobs, "shell job") : "",
    work.subagents ? plural(work.subagents, "subagent") : "",
  ]
    .filter(Boolean)
    .join(" and ");
}

/**
 * Asks before `/tree` moves away from running background work, and before
 * `/new`, `/resume`, `/fork`, or `/clone` leave the session, which stops it.
 */
export function registerGuards(
  pi: ExtensionAPI,
  work: () => { jobs: number; subagents: number },
): void {
  const confirm = async (
    ctx: ExtensionContext,
    consequence: (one: boolean) => string,
  ): Promise<{ cancel: true } | undefined> => {
    const counts = work();
    const text = workText(counts);
    if (!text || !ctx.hasUI) return undefined;
    const one = counts.jobs + counts.subagents === 1;
    const running = `${text} ${one ? "is" : "are"} still running.`;
    const go = await ctx.ui.confirm(TITLE, `${running} ${consequence(one)}`);
    return go ? undefined : { cancel: true };
  };
  pi.on("session_before_tree", (_event, ctx) =>
    confirm(
      ctx,
      (one) =>
        `${one ? "Its result" : "Their results"} will arrive on the branch you move to, not on the branch that started ${one ? "it" : "them"}. Move anyway?`,
    ),
  );
  const leaving = (one: boolean) =>
    `Leaving this session stops ${one ? "it" : "them"}. Continue?`;
  pi.on("session_before_switch", (_event, ctx) => confirm(ctx, leaving));
  pi.on("session_before_fork", (_event, ctx) => confirm(ctx, leaving));
}
