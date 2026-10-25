import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/is-record.ts";
import { CUSTOM_TOOL_EXTENSIONS, findAgent } from "./agents.ts";
import {
  forwardDialog,
  forwardNotification,
  type ParentUI,
} from "./dialogs.ts";
import type { Limiter } from "./limiter.ts";
import { type DialogHandler, RpcChild, type RpcRecord } from "./rpc.ts";
import type { RunRegistry, SubagentRun } from "./runs.ts";
import {
  findSession,
  newSessionId,
  readSessionCwd,
  SESSIONS_DIR,
  type SessionTarget,
  sessionAgent,
  sessionArguments,
  sessionName,
} from "./sessions.ts";
import { ASK_FLAG } from "./tools/safe-bash.ts";
import {
  applyTranscriptEvent,
  countMessageEntries,
  emptyTranscript,
} from "./transcript.ts";
import { releaseTranscript } from "./transcript-view.ts";
import type {
  AgentDefinition,
  AgentResult,
  ToolEvent,
  UsageStats,
} from "./types.ts";

interface JsonEvent {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  message?: unknown;
}

function resolvePiInvocation(args: string[]): {
  command: string;
  args: string[];
} {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const runtime = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(runtime)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

export function pendingResult(
  agent: string,
  task: string,
  sessionId: string,
): AgentResult {
  return {
    agent,
    task,
    sessionId,
    output: "",
    exitCode: -1,
    usage: emptyUsage(),
    progress: {
      status: "pending",
      recentTools: [],
      toolCount: 0,
      durationMs: 0,
      lastMessage: "",
    },
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function toolArgsPreview(args: unknown): string {
  if (!isRecord(args)) return "";
  for (const key of ["command", "path", "query", "url", "pattern"]) {
    if (typeof args[key] === "string") return String(args[key]).slice(0, 100);
  }
  return JSON.stringify(args).slice(0, 100);
}

function addUsage(target: UsageStats, value: unknown): void {
  if (!isRecord(value)) return;
  target.input += typeof value.input === "number" ? value.input : 0;
  target.output += typeof value.output === "number" ? value.output : 0;
  target.cacheRead += typeof value.cacheRead === "number" ? value.cacheRead : 0;
  target.cacheWrite +=
    typeof value.cacheWrite === "number" ? value.cacheWrite : 0;
  if (isRecord(value.cost) && typeof value.cost.total === "number") {
    target.cost += value.cost.total;
  }
}

// By call id: a model can run several tools at once.
const runningTools = new WeakMap<AgentResult, Map<string, ToolEvent>>();

function showLatestRunningTool(result: AgentResult): void {
  const latest = [...(runningTools.get(result)?.values() ?? [])].at(-1);
  result.progress.currentTool = latest?.tool;
  result.progress.currentToolArgs = latest?.args;
}

export function applyEvent(result: AgentResult, record: RpcRecord): void {
  const event = record as JsonEvent;
  const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (event.type === "tool_execution_start") {
    result.progress.toolCount += 1;
    let running = runningTools.get(result);
    if (!running) {
      running = new Map();
      runningTools.set(result, running);
    }
    running.set(callId, {
      tool: typeof event.toolName === "string" ? event.toolName : "tool",
      args: toolArgsPreview(event.args),
    });
    showLatestRunningTool(result);
    return;
  }
  if (event.type === "tool_execution_end") {
    const running = runningTools.get(result);
    const tool = running?.get(callId);
    if (tool) {
      running?.delete(callId);
      result.progress.recentTools.push(tool);
      result.progress.recentTools = result.progress.recentTools.slice(-20);
    }
    showLatestRunningTool(result);
    return;
  }
  if (event.type === "auto_retry_end" && record.success === false) {
    result.progress.error =
      typeof record.finalError === "string"
        ? record.finalError
        : "Retries failed";
    return;
  }
  if (event.type !== "message_end" || !isRecord(event.message)) return;
  if (event.message.role !== "assistant") return;

  result.usage.turns += 1;
  addUsage(result.usage, event.message.usage);
  if (typeof event.message.model === "string") {
    result.model = event.message.model;
  }
  const { errorMessage, stopReason } = event.message;
  if (
    typeof errorMessage === "string" ||
    stopReason === "error" ||
    stopReason === "aborted"
  ) {
    result.progress.error =
      typeof errorMessage === "string"
        ? errorMessage
        : `Agent stopped: ${String(stopReason)}`;
  } else {
    // A successful turn after a failed one means Pi's retry worked.
    result.progress.error = undefined;
  }
  const text = contentText(event.message.content);
  if (text) {
    result.output = text;
    result.progress.lastMessage = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  }
}

export function subagentToolSelectionArgs(tools: string[]): string[] {
  return tools.length > 0 ? ["--tools", tools.join(",")] : ["--no-tools"];
}

export function selectSubagentModel(
  preferences: string[],
  availableModels: ReadonlySet<string>,
  parentModel: string | undefined,
): string | undefined {
  return preferences.find((model) => availableModels.has(model)) ?? parentModel;
}

export function subagentArguments(
  tools: string[],
  systemPromptPath: string,
  selectedModel: string | undefined,
  thinkingLevel: string | undefined,
  sessionArgs: string[],
  userAvailable: boolean,
): string[] {
  const args = ["--mode", "rpc", ...sessionArgs];
  args.push("--no-skills", "--no-extensions");
  args.push(...subagentToolSelectionArgs(tools));

  const extensionPaths = new Set(
    tools
      .map((tool) => CUSTOM_TOOL_EXTENSIONS[tool])
      .filter((extension): extension is string => Boolean(extension)),
  );
  for (const extensionPath of extensionPaths) {
    args.push("--extension", extensionPath);
  }

  if (selectedModel) args.push("--model", selectedModel);
  if (thinkingLevel && thinkingLevel !== "off") {
    args.push("--thinking", thinkingLevel);
  }
  if (userAvailable && tools.includes("safe_bash")) args.push(`--${ASK_FLAG}`);
  args.push("--append-system-prompt", systemPromptPath);
  return args;
}

export interface TaskRequest {
  agent?: string;
  task: string;
  cwd?: string;
  session?: string;
}

interface RunPlan {
  agent: AgentDefinition;
  task: string;
  cwd: string;
  target: SessionTarget;
}

export function planRun(
  request: TaskRequest,
  agents: AgentDefinition[],
  defaultCwd: string,
  directory: string = SESSIONS_DIR,
): RunPlan {
  const { task, session } = request;
  if (!session) {
    if (!request.agent) throw new Error("Provide an agent or a session");
    const agent = findAgent(agents, request.agent);
    return {
      agent,
      task,
      cwd: request.cwd ?? defaultCwd,
      target: {
        kind: "new",
        id: newSessionId(agent.name),
        name: sessionName(agent.name, task),
      },
    };
  }

  const agentName = sessionAgent(session);
  if (!agentName) throw new Error(`Malformed subagent session id ${session}`);
  if (request.agent && request.agent !== agentName) {
    throw new Error(
      `Subagent session ${session} belongs to ${agentName}, not ${request.agent}`,
    );
  }
  if (request.cwd) {
    throw new Error(
      "cwd cannot be combined with session; a resumed subagent keeps its working directory",
    );
  }
  const path = findSession(session, directory);
  if (!path) {
    throw new Error(`Unknown subagent session ${session} in ${directory}`);
  }
  return {
    agent: findAgent(agents, agentName),
    task,
    cwd: readSessionCwd(path),
    target: { kind: "resume", id: session, path },
  };
}

export interface RunContext {
  parentModel: string | undefined;
  availableModels: ReadonlySet<string>;
  thinkingLevel: string | undefined;
  signal: AbortSignal | undefined;
  // The parent UI, or undefined when no user can answer.
  ui: ParentUI | undefined;
  enqueueDialog: <T>(task: () => Promise<T>) => Promise<T>;
  // Background runs queue their dialogs in /agents instead of opening them
  // over the user's work.
  background: boolean;
  registry: RunRegistry;
  questionTimeoutMs: number;
}

/**
 * A run that reached agent_settled keeps its answer when Pi then had to be
 * stopped: the session is complete, because Pi writes each entry at once.
 */
export function finalStatus(
  exitCode: number,
  settled: boolean,
  forcedStop: boolean,
  error: string | undefined,
): "completed" | "failed" {
  const exitedCleanly = exitCode === 0 || (settled && forcedStop);
  return exitedCleanly && !error ? "completed" : "failed";
}

async function runAgent(
  plan: RunPlan,
  run: SubagentRun,
  context: RunContext,
  onUpdate?: (result: AgentResult) => void,
): Promise<AgentResult> {
  const { agent, task, cwd, target } = plan;
  const { parentModel, availableModels, thinkingLevel, ui } = context;
  const { result } = run;
  const signal = context.signal
    ? AbortSignal.any([context.signal, run.stop.signal])
    : run.stop.signal;
  const selectedModel = selectSubagentModel(
    agent.modelPreferences,
    availableModels,
    parentModel,
  );
  const inheritThinkingLevel =
    selectedModel !== undefined && selectedModel === parentModel;
  result.model = selectedModel;
  result.progress.status = "running";
  result.cwd = cwd;
  result.live = emptyTranscript();
  result.messageStart =
    target.kind === "resume" ? countMessageEntries(target.path) : 0;
  const startedAt = Date.now();

  let runSettled = false;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const promptPath = join(temporaryDirectory, `${agent.name}.md`);
  try {
    await writeFile(promptPath, agent.systemPrompt, {
      encoding: "utf8",
      mode: 0o600,
    });
    const invocation = resolvePiInvocation(
      subagentArguments(
        agent.tools,
        promptPath,
        selectedModel,
        inheritThinkingLevel ? thinkingLevel : undefined,
        sessionArguments(target),
        ui !== undefined,
      ),
    );
    let onDialog: DialogHandler | undefined;
    if (ui && context.background) {
      onDialog = (request, childExited) => {
        ui.notify(
          `${target.id} is waiting for your answer. Open /agents to reply.`,
          "info",
        );
        return context.registry.ask(
          run,
          request,
          context.questionTimeoutMs,
          AbortSignal.any([signal, childExited]),
        );
      };
    } else if (ui) {
      onDialog = (request, childExited) =>
        forwardDialog(
          context.enqueueDialog,
          ui,
          request,
          target.id,
          AbortSignal.any([signal, childExited]),
        );
    }
    const child = new RpcChild(
      invocation.command,
      invocation.args,
      cwd,
      onDialog,
    );

    run.child = child;

    let settle = () => {};
    let settledRun = false;
    const settled = new Promise<void>((resolve) => {
      settle = () => {
        settledRun = true;
        resolve();
      };
    });
    child.onRecord((record) => {
      if (record.type === "agent_settled") {
        // A message sent now would never run, so the child stops taking them.
        run.child = undefined;
        settle();
        return;
      }
      if (
        ui &&
        record.type === "extension_ui_request" &&
        record.method === "notify"
      ) {
        forwardNotification(ui, record, target.id);
      }
      applyEvent(result, record);
      if (result.live) applyTranscriptEvent(result.live, record);
      result.progress.durationMs = Date.now() - startedAt;
      onUpdate?.(result);
    });

    const abort = () => void child.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try {
      const data = await child.send({
        type: "prompt",
        message: `Task: ${task}`,
      });
      const disposition = isRecord(data) ? data.disposition : undefined;
      if (disposition !== "started") {
        throw new Error(
          `Subagent did not start a run (${String(disposition)})`,
        );
      }
      const finished = await Promise.race([
        settled.then(() => true),
        child.exited.then(() => false),
      ]);
      if (!finished) {
        throw new Error(
          `Subagent exited before finishing${child.stderr() ? `: ${child.stderr()}` : ""}`,
        );
      }
    } catch (error) {
      result.progress.error ??=
        error instanceof Error ? error.message : String(error);
    } finally {
      signal.removeEventListener("abort", abort);
      run.child = undefined;
      result.exitCode = await child.close();
    }
    result.sessionFile =
      target.kind === "resume" ? target.path : findSession(target.id);
    result.messageEnd = countMessageEntries(result.sessionFile);
    const forced = child.forcedStop;
    if (forced && settledRun) {
      const detail = child.stderr() ? `: ${child.stderr()}` : "";
      result.progress.warning = `Pi did not exit after the run and was stopped with ${forced}${detail}`;
    } else if (
      result.exitCode !== 0 &&
      !result.progress.error &&
      child.stderr()
    ) {
      result.progress.error = child.stderr();
    }
    runSettled = settledRun;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (run.stop.signal.aborted && !context.signal?.aborted) {
    result.progress.error = "Stopped by the user";
  } else if (signal.aborted) {
    result.progress.error = "Subagent was aborted";
  }

  result.progress.durationMs = Date.now() - startedAt;
  result.progress.status = finalStatus(
    result.exitCode,
    runSettled,
    result.progress.warning !== undefined,
    result.progress.error,
  );
  if (!result.output && result.progress.error) {
    result.output = `Error: ${result.progress.error}`;
  }
  const truncated = truncateHead(result.output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  result.output = truncated.content;
  if (truncated.truncated) result.output += "\n\n[Subagent output truncated]";
  if (result.live) {
    releaseTranscript([...result.live.messages, result.live.streaming]);
  }
  result.live = undefined;
  onUpdate?.(result);
  return result;
}

/**
 * A run that throws becomes a failed result,
 * so every run reaches a final status.
 */
export async function runAll(
  plans: RunPlan[],
  runs: SubagentRun[],
  limiter: Limiter,
  context: RunContext,
  update: () => void,
  onRunEnd?: (result: AgentResult, index: number) => void,
): Promise<AgentResult[]> {
  return Promise.all(
    plans.map(async (plan, index) => {
      const run = runs[index];
      const waitSignal = context.signal
        ? AbortSignal.any([context.signal, run.stop.signal])
        : run.stop.signal;
      try {
        await limiter.run(
          () => runAgent(plan, run, context, update),
          waitSignal,
        );
      } catch (error) {
        run.child = undefined;
        run.result.live = undefined;
        run.result.progress.status = "failed";
        run.result.progress.error =
          run.stop.signal.aborted && !context.signal?.aborted
            ? "Stopped by the user"
            : context.signal?.aborted
              ? "Subagent was aborted"
              : error instanceof Error
                ? error.message
                : String(error);
        run.result.output ||= `Error: ${run.result.progress.error}`;
      }
      update();
      onRunEnd?.(run.result, index);
      return run.result;
    }),
  );
}
