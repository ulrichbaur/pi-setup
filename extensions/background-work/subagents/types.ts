import type { LiveTranscript } from "./transcript.ts";

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  modelPreferences: string[];
  systemPrompt: string;
}

export interface ToolEvent {
  tool: string;
  args: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface AgentProgress {
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "timed_out"
    // Stopped on request: by the user, subagent_stop, or an aborted call.
    | "stopped"
    // Cut off when Pi closed its session.
    | "interrupted";
  currentTool?: string;
  currentToolArgs?: string;
  recentTools: ToolEvent[];
  toolCount: number;
  durationMs: number;
  lastMessage: string;
  error?: string;
  // Something went wrong that did not cost the run its answer.
  warning?: string;
}

export interface AgentResult {
  agent: string;
  task: string;
  output: string;
  exitCode: number;
  model?: string;
  usage: UsageStats;
  progress: AgentProgress;
  // A background invocation has its own ID even when it resumes a session.
  runId?: string;
  sessionId: string;
  // Absent when a run failed before Pi wrote its session file.
  sessionFile?: string;
  cwd?: string;
  // The run's messages in the session file, counted in message entries.
  messageStart?: number;
  messageEnd?: number;
  // Present only while the run streams; the saved result reads the file.
  live?: LiveTranscript;
  // The question the subagent asked its parent when its run ended.
  question?: string;
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  results: AgentResult[];
  // The results are placeholders; the real ones arrive as a message.
  background?: boolean;
  // The runs ended without a result because their session closed.
  interrupted?: boolean;
}

// The custom message that carries a background run's results.
export const RESULT_MESSAGE_TYPE = "subagent-result";

/**
 * A token is cancelled when its session shuts down, so a late result never
 * reaches another session.
 */
export interface Delivery {
  start(): { cancelled: boolean };
  deliver(
    token: { cancelled: boolean },
    details: SubagentDetails,
    options?: { triggerTurn?: boolean },
  ): void;
}
