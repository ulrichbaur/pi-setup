import type { AgentResult } from "../../../extensions/subagents/index.ts";
import type { SubagentRun } from "../../../extensions/subagents/runs.ts";

export function fakeRun(
  sessionId: string,
  status: AgentResult["progress"]["status"] = "running",
): SubagentRun {
  return {
    stop: new AbortController(),
    pendingDialogs: [],
    result: {
      agent: "scout",
      task: `task of ${sessionId}`,
      output: "",
      exitCode: -1,
      sessionId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      progress: {
        status,
        recentTools: [],
        toolCount: 0,
        durationMs: 0,
        lastMessage: "",
      },
    },
  };
}
