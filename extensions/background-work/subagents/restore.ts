import { isRecord } from "../../../lib/is-record.ts";
import { isActive, type SubagentRun } from "./runs.ts";
import { countMessageEntries } from "./transcript.ts";
import type { AgentResult } from "./types.ts";
import { sessionUsage } from "./usage.ts";

const SUBAGENT_TOOL = "subagent";

/** The results in saved details that match today's result shape. */
export function validResults(details: unknown): AgentResult[] {
  if (!isRecord(details) || !Array.isArray(details.results)) return [];
  return details.results.filter(
    (result): result is AgentResult =>
      isRecord(result) &&
      typeof result.agent === "string" &&
      typeof result.task === "string" &&
      typeof result.sessionId === "string" &&
      isRecord(result.progress),
  );
}

/** Identifies one run's result, saved or live, without object identity. */
export function resultKey(result: AgentResult): string {
  if (result.runId) return result.runId;
  return [
    result.agent,
    result.sessionId,
    result.messageStart,
    result.messageEnd,
  ].join(":");
}

function finishedRun(result: AgentResult): SubagentRun {
  return { result, stop: new AbortController() };
}

/** Where the run's own messages start in its session file. */
function runStart(runs: readonly SubagentRun[], index: number): number {
  const { sessionId } = runs[index].result;
  let start = 0;
  for (const earlier of runs.slice(0, index)) {
    const { result } = earlier;
    if (earlier.undelivered || result.sessionId !== sessionId) continue;
    start = Math.max(start, result.messageEnd ?? 0);
  }
  return start;
}

/**
 * The results to report for background launches that never delivered,
 * because their session closed. `sessionFile` finds the subagent's session
 * file: a run with one can be continued, and its saved messages give its
 * usage and transcript.
 */
export function interruptedResults(
  runs: readonly SubagentRun[],
  sessionFile: (sessionId: string) => string | undefined,
): AgentResult[] {
  const results: AgentResult[] = [];
  runs.forEach((run, index) => {
    if (!run.undelivered) return;
    const { result } = run;
    const { sessionId } = result;
    const path = sessionFile(sessionId);
    let usage = result.usage;
    let range: Partial<AgentResult> = {};
    let note = "";
    if (path) {
      const start = runStart(runs, index);
      try {
        usage = sessionUsage(path, start);
        range = {
          sessionFile: path,
          messageStart: start,
          messageEnd: countMessageEntries(path),
        };
      } catch (error) {
        note = ` Its cost could not be read: ${error instanceof Error ? error.message : String(error)}.`;
      }
    }
    const hint = path
      ? `Interrupted: the session closed before this run ended, by quitting Pi, /reload, or a session switch. Its subagent session ${sessionId} is saved. To finish the work, call subagent with that session and a follow-up task.${note}`
      : "Interrupted: the session closed before this run ended, by quitting Pi, /reload, or a session switch. No subagent session was saved, so it cannot be continued. Launch it again if you still need it.";
    results.push({
      ...result,
      ...range,
      usage,
      output: hint,
      progress: { ...result.progress, lastMessage: hint },
    });
  });
  return results;
}

/**
 * The runs saved in the branch, oldest first. A restored run is never
 * active: one still pending or running ended when its session closed.
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
      for (const result of validResults(message.details)) {
        const id = result.runId;
        const run = {
          ...finishedRun({ ...result }),
          undelivered: background && Boolean(id),
        };
        runs.push(run);
        if (background && id) undelivered.set(id, run);
      }
    } else if (
      entry.type === "custom_message" &&
      entry.customType === resultMessageType
    ) {
      for (const result of validResults(entry.details)) {
        const id = result.runId;
        if (id) {
          const placeholder = undelivered.get(id);
          if (placeholder) {
            runs.splice(runs.indexOf(placeholder), 1);
            undelivered.delete(id);
          }
        }
        runs.push(finishedRun(result));
      }
    }
  }
  // A run read back from a saved session cannot still run in this process.
  // That covers launches whose result never arrived, with or without a run ID.
  for (const run of runs) {
    if (!isActive(run)) continue;
    run.result.progress = {
      ...run.result.progress,
      status: "interrupted",
      error: "Interrupted when its session closed",
    };
  }
  return runs;
}
