import type { LiveTranscript } from "./transcript.ts";

export type AgentSource = "package" | "user" | "project";

export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  modelPreferences: string[];
  systemPrompt: string;
  source: AgentSource;
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
  status: "pending" | "running" | "completed" | "failed";
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
  // Absent in results saved before subagent sessions existed; sessionFile also
  // when a run failed before Pi wrote it.
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  // The run's messages in the session file, counted in message entries.
  messageStart?: number;
  messageEnd?: number;
  // Present only while the run streams; the saved result reads the file.
  live?: LiveTranscript;
  userMessages?: string[];
  // The question the subagent asked its parent when its run ended.
  question?: string;
  // Where a user or project agent came from; absent for package agents.
  agentSource?: "user" | "project";
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  results: AgentResult[];
  // The results are placeholders; the real ones arrive as a message.
  background?: boolean;
}

// The custom message that carries a background run's results.
export const RESULT_MESSAGE_TYPE = "subagent-result";

/**
 * A token is cancelled when its session shuts down, so a late result never
 * reaches another session.
 */
export interface Delivery {
  start(): { cancelled: boolean };
  deliver(token: { cancelled: boolean }, details: SubagentDetails): void;
}
