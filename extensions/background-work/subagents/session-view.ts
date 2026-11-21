import { resultKey } from "./restore.ts";
import { isActive, type SubagentRun } from "./runs.ts";

/** Display-only session rows, newest first. The registry keeps individual runs. */
export function sessionRows(runs: SubagentRun[]): SubagentRun[] {
  const groups = new Map<string | SubagentRun, SubagentRun[]>();
  for (const run of runs) {
    const key = run.result.sessionId ?? run;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const latest = group.find(isActive) ?? group[0];
    const history = group.find((run) => run.result.sessionFile);
    const result = {
      ...latest.result,
      sessionFile: latest.result.sessionFile ?? history?.result.sessionFile,
      messageEnd: latest.result.messageEnd ?? history?.result.messageEnd,
      usage: { ...latest.result.usage },
      progress: { ...latest.result.progress },
    };
    result.usage.cost = 0;
    result.progress.toolCount = 0;
    result.progress.durationMs = 0;
    const seen = new Set<string>();
    for (const run of group) {
      const key = resultKey(run.result);
      if (seen.has(key)) continue;
      seen.add(key);
      result.usage.cost += run.result.usage.cost;
      result.progress.toolCount += run.result.progress.toolCount;
      result.progress.durationMs += run.result.progress.durationMs;
    }
    return { result, stop: latest.stop };
  });
}

export function sameSession(a: SubagentRun, b: SubagentRun): boolean {
  return a.result.sessionId !== undefined
    ? a.result.sessionId === b.result.sessionId
    : a.stop === b.stop;
}
