import { isRecord } from "../../lib/is-record.ts";
import type { AgentResult } from "./index.ts";
import type { SubagentRun } from "./runs.ts";

const SUBAGENT_TOOL = "subagent";

function savedResults(details: unknown): AgentResult[] {
  if (!isRecord(details) || !Array.isArray(details.results)) return [];
  return details.results.filter(
    (result): result is AgentResult =>
      isRecord(result) &&
      typeof result.agent === "string" &&
      typeof result.task === "string" &&
      isRecord(result.progress),
  );
}

/** Identifies one run's result, saved or live, without object identity. */
export function resultKey(result: AgentResult): string {
  return [
    result.agent,
    result.sessionId,
    result.messageStart,
    result.messageEnd,
  ].join(":");
}

function finishedRun(result: AgentResult): SubagentRun {
  return { result, stop: new AbortController(), pendingDialogs: [] };
}

/**
 * Oldest first. A background run without a delivered result
 * ended when its session closed.
 */
export function savedRuns(
  entries: readonly unknown[],
  resultMessageType: string,
): SubagentRun[] {
  const runs: SubagentRun[] = [];
  const undelivered = new Map<string, SubagentRun>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const message = entry.message;
    if (
      entry.type === "message" &&
      isRecord(message) &&
      message.role === "toolResult" &&
      message.toolName === SUBAGENT_TOOL
    ) {
      const background =
        isRecord(message.details) && message.details.background === true;
      for (const result of savedResults(message.details)) {
        const run = finishedRun({ ...result });
        runs.push(run);
        if (background && result.sessionId) {
          undelivered.set(result.sessionId, run);
        }
      }
    } else if (
      entry.type === "custom_message" &&
      entry.customType === resultMessageType
    ) {
      for (const result of savedResults(entry.details)) {
        const placeholder = result.sessionId
          ? undelivered.get(result.sessionId)
          : undefined;
        if (placeholder) {
          runs.splice(runs.indexOf(placeholder), 1);
          undelivered.delete(result.sessionId as string);
        }
        runs.push(finishedRun(result));
      }
    }
  }
  for (const run of undelivered.values()) {
    run.result.progress = {
      ...run.result.progress,
      status: "failed",
      error: "Stopped when its session closed",
    };
  }
  return runs;
}
