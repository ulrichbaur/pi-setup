import { Type } from "typebox";
import {
  isActive,
  type RunLookup,
  type RunRegistry,
  type SubagentRun,
} from "./runs.ts";
import { runLookupFields } from "./status.ts";

/** Covers the child's abort and the forced stop of a child that hangs. */
export const STOP_WAIT_MS = 10_000;

/** Resolves when the run ends, `waitMs` passes, or `signal` aborts. */
function waitForEnd(
  registry: RunRegistry,
  run: SubagentRun,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    const unsubscribe = registry.subscribe(() => {
      if (!isActive(run)) finish();
    });
    signal?.addEventListener("abort", finish, { once: true });
    if (!isActive(run) || signal?.aborted) finish();
  });
}

export function stopTool(registry: RunRegistry, waitMs = STOP_WAIT_MS) {
  return {
    name: "subagent_stop",
    label: "Stop subagent",
    description: `Stop a background subagent run by run ID or session ID. Waits up to ${waitMs / 1_000} seconds for the run to end and reports its final status. The run's result message follows without starting a new turn.`,
    parameters: Type.Object(runLookupFields, { additionalProperties: false }),
    async execute(_id: string, lookup: RunLookup, signal?: AbortSignal) {
      const run = registry.find(lookup);
      const { result } = run;
      const runId = result.runId as string;
      const name = `${result.agent} (run ID: ${runId}, session: ${result.sessionId})`;
      let text: string;
      if (!isActive(run)) {
        text = `Background subagent ${name} had already ended: ${result.progress.status}.`;
      } else {
        registry.stop(run, "parent");
        await waitForEnd(registry, run, waitMs, signal);
        text = isActive(run)
          ? `Stop requested for background subagent ${name}. It is still stopping. Its result message follows when it ends.`
          : `Stopped background subagent ${name}: ${result.progress.status}. Its result message follows.`;
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { runId, status: result.progress.status },
      };
    },
  };
}
