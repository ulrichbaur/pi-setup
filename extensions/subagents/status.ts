import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunRegistry, SubagentRun } from "./runs.ts";

function describe({ result, startedAt }: SubagentRun, now: number) {
  const { status, durationMs, error, lastMessage } = result.progress;
  const finished = status !== "pending" && status !== "running";
  const preview =
    (result.output || lastMessage).replace(/\s+/g, " ").trim().slice(0, 240) ||
    undefined;
  return {
    runId: result.runId,
    sessionId: result.sessionId,
    agent: result.agent,
    status,
    elapsedMs:
      status === "running" && startedAt !== undefined
        ? Math.max(0, now - startedAt)
        : durationMs,
    ...(finished && {
      error: error?.slice(0, 240),
      ...(status === "timed_out"
        ? { partialOutput: preview }
        : { result: preview }),
    }),
  };
}

export function statusTool(registry: RunRegistry) {
  return {
    name: "subagent_status",
    label: "Subagent status",
    description:
      "List background subagent runs or inspect one by run ID. Returns immediately without consuming completion messages. Use on demand, not to poll for results.",
    parameters: Type.Object(
      { runId: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    async execute(_id: string, { runId }: { runId?: string }) {
      const runs = registry.list().filter((run) => run.result.runId);
      const selected =
        runId === undefined
          ? runs
          : runs.filter((run) => run.result.runId === runId);
      if (runId !== undefined && !selected.length) {
        throw new Error(`Unknown background subagent run: ${runId}`);
      }
      const now = Date.now();
      const details = selected.map((run) => describe(run, now));
      return {
        content: [
          {
            type: "text" as const,
            text: details.length
              ? JSON.stringify(details, null, 2)
              : "No background subagent runs.",
          },
        ],
        details,
      };
    },
  };
}

const STATUS_KEY = "subagents";

export function watchSubagentStatus(
  registry: RunRegistry,
  ui: Pick<ExtensionUIContext, "setStatus">,
): () => void {
  let previous: string | undefined;
  const refresh = () => {
    let running = 0;
    let pending = 0;
    for (const { result } of registry.list()) {
      if (!result.runId) continue;
      if (result.progress.status === "running") running++;
      if (result.progress.status === "pending") pending++;
    }
    const text =
      running || pending
        ? `Subagents: ${running} running${pending ? ` · ${pending} queued` : ""}`
        : undefined;
    if (text === previous) return;
    previous = text;
    ui.setStatus(STATUS_KEY, text);
  };
  const unsubscribe = registry.subscribe(refresh);
  refresh();
  return () => {
    unsubscribe();
    if (previous !== undefined) ui.setStatus(STATUS_KEY, undefined);
  };
}
