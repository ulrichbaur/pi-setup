import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  getMarkdownTheme,
  parseFrontmatter,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isRecord } from "../../lib/is-record.ts";
import {
  formatCost,
  SUBAGENT_COST_CHANNEL,
  type SubagentCostEvent,
} from "../../lib/subagent-cost.ts";
import { AgentsOverlay, type OverlayChoice } from "./agents-view.ts";
import {
  createDialogQueue,
  forwardDialog,
  forwardNotification,
  type ParentUI,
} from "./dialogs.ts";
import { Limiter } from "./limiter.ts";
import { openSubagentSession, returnToParent } from "./navigation.ts";
import { resultKey, savedRuns } from "./restore.ts";
import { type DialogHandler, RpcChild, type RpcRecord } from "./rpc.ts";
import { RunRegistry, type SubagentRun } from "./runs.ts";
import {
  AGENT_NAME_PATTERN,
  findSession,
  listSavedSessions,
  newSessionId,
  pruneSessions,
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
  type LiveTranscript,
} from "./transcript.ts";
import {
  releaseTranscript,
  type TranscriptDisplay,
  transcriptView,
} from "./transcript-view.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(EXTENSION_DIR, "..", "..");
const AGENTS_DIR = join(EXTENSION_DIR, "agents");
// Config is machine-local state, so it lives with Pi's other agent files.
export const CONFIG_PATH = join(getAgentDir(), "subagents.json");
// Subagents never get the raw bash tool; safe_bash is the only shell.
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  safe_bash: join(EXTENSION_DIR, "tools", "safe-bash.ts"),
  web_fetch: join(EXTENSION_DIR, "..", "web-fetch", "index.ts"),
  web_search: join(EXTENSION_DIR, "..", "web-search", "index.ts"),
  ask_user: join(EXTENSION_DIR, "tools", "ask-user.ts"),
};

interface AgentModelConfig {
  models: string[];
}

interface SubagentConfig {
  maxConcurrency: number;
  maxParallelTasks: number;
  sessionRetentionDays: number;
  backgroundQuestionTimeoutMinutes: number;
  agents: Record<string, AgentModelConfig>;
}

type AgentSource = "package" | "user" | "project";

interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  modelPreferences: string[];
  systemPrompt: string;
  source: AgentSource;
}

interface ToolEvent {
  tool: string;
  args: string;
}

interface UsageStats {
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
  // Where a user or project agent came from; absent for package agents.
  agentSource?: "user" | "project";
}

export interface SubagentDetails {
  mode: "single" | "parallel";
  results: AgentResult[];
  // The results are placeholders; the real ones arrive as a message.
  background?: boolean;
}

const SAVED_SESSION_LIMIT = 200;

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

interface JsonEvent {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  args?: unknown;
  message?: unknown;
}

export const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrency: 4,
  maxParallelTasks: 8,
  sessionRetentionDays: 90,
  backgroundQuestionTimeoutMinutes: 10,
  agents: {},
};

function positiveInteger(
  value: unknown,
  field: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${CONFIG_PATH}: ${field} must be a positive integer`);
  }
  return value as number;
}

/** Validates an optional config; omitted fields take the built-in defaults. */
export function parseSubagentConfig(value: unknown): SubagentConfig {
  if (!isRecord(value)) {
    throw new Error(`${CONFIG_PATH}: expected a JSON object`);
  }
  const agentValues = value.agents ?? {};
  if (!isRecord(agentValues)) {
    throw new Error(`${CONFIG_PATH}: agents must be an object`);
  }

  const agents: Record<string, AgentModelConfig> = {};
  for (const [name, agentValue] of Object.entries(agentValues)) {
    if (!isRecord(agentValue)) {
      throw new Error(`${CONFIG_PATH}: agents.${name} must be an object`);
    }
    if (agentValue.model !== undefined) {
      throw new Error(
        `${CONFIG_PATH}: agents.${name}.model is unsupported; use models`,
      );
    }
    const configuredModels = agentValue.models ?? [];
    if (
      !Array.isArray(configuredModels) ||
      configuredModels.some(
        (model) => typeof model !== "string" || !model.trim(),
      )
    ) {
      throw new Error(
        `${CONFIG_PATH}: agents.${name}.models must contain model ids`,
      );
    }
    agents[name] = {
      models: configuredModels.map((model) => (model as string).trim()),
    };
  }

  return {
    maxConcurrency: positiveInteger(
      value.maxConcurrency,
      "maxConcurrency",
      DEFAULT_CONFIG.maxConcurrency,
    ),
    maxParallelTasks: positiveInteger(
      value.maxParallelTasks,
      "maxParallelTasks",
      DEFAULT_CONFIG.maxParallelTasks,
    ),
    sessionRetentionDays: positiveInteger(
      value.sessionRetentionDays,
      "sessionRetentionDays",
      DEFAULT_CONFIG.sessionRetentionDays,
    ),
    backgroundQuestionTimeoutMinutes: positiveInteger(
      value.backgroundQuestionTimeoutMinutes,
      "backgroundQuestionTimeoutMinutes",
      DEFAULT_CONFIG.backgroundQuestionTimeoutMinutes,
    ),
    agents,
  };
}

function loadConfig(): SubagentConfig {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    return parseSubagentConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${CONFIG_PATH}: invalid JSON`, { cause: error });
    }
    throw error;
  }
}

function parseTools(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values
    .filter((tool): tool is string => typeof tool === "string")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

/**
 * Rejects unknown tools and custom tools whose sibling extension is missing,
 * so a broken dependency fails when the extension loads rather than inside a
 * child process.
 */
export function assertSupportedTools(
  fileName: string,
  tools: string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  for (const tool of tools) {
    const extensionPath = CUSTOM_TOOL_EXTENSIONS[tool];
    if (!BUILTIN_TOOLS.has(tool) && !extensionPath) {
      throw new Error(`${fileName}: unsupported subagent tool ${tool}`);
    }
    if (extensionPath && !exists(extensionPath)) {
      const shown = relative(PACKAGE_DIR, extensionPath);
      throw new Error(
        `${fileName}: tool ${tool} needs ${shown}, which is missing`,
      );
    }
  }
  return tools;
}

/** Agent names become part of session ids, so they use a restricted set. */
export function assertAgentName(fileName: string, name: string): string {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `${fileName}: agent name ${name} may contain only letters, digits, _, and -, and must start with a letter or digit`,
    );
  }
  return name;
}

export const USER_AGENTS_DIR = join(getAgentDir(), "agents");

export function projectAgentsDir(cwd: string): string {
  return join(cwd, ".pi", "agents");
}

export function readAgentDir(
  directory: string,
  source: AgentSource,
  config: SubagentConfig,
): AgentDefinition[] {
  const names = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".md"))
    : [];
  const agents = names.map((name): AgentDefinition => {
    const file = join(directory, name);
    const label = source === "package" ? name : file;
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
      readFileSync(file, "utf8"),
    );
    if (
      typeof frontmatter.name !== "string" ||
      typeof frontmatter.description !== "string"
    ) {
      throw new Error(`${label}: an agent needs a name and a description`);
    }
    return {
      name: assertAgentName(label, frontmatter.name),
      description: frontmatter.description,
      tools: assertSupportedTools(label, parseTools(frontmatter.tools)),
      modelPreferences: config.agents[frontmatter.name]?.models ?? [],
      systemPrompt: body,
      source,
    };
  });
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.name)) {
      throw new Error(`${directory}: agent ${agent.name} is defined twice`);
    }
    seen.add(agent.name);
  }
  return agents;
}

/** Later lists override earlier ones by name: package, user, project. */
export function mergeAgents(...lists: AgentDefinition[][]): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of lists.flat()) byName.set(agent.name, agent);
  return [...byName.values()];
}

function loadAgents(config: SubagentConfig): AgentDefinition[] {
  const agents = mergeAgents(
    readAgentDir(AGENTS_DIR, "package", config),
    readAgentDir(USER_AGENTS_DIR, "user", config),
  );
  if (agents.length === 0) {
    throw new Error(`${AGENTS_DIR}: no valid agent definitions found`);
  }
  const loadedNames = new Set(agents.map((agent) => agent.name));
  for (const name of Object.keys(config.agents)) {
    if (!loadedNames.has(name)) {
      throw new Error(
        `${CONFIG_PATH}: agents.${name} has no matching agent file`,
      );
    }
  }
  return agents;
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

function pendingResult(
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

function findAgent(agents: AgentDefinition[], name: string): AgentDefinition {
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent) {
    throw new Error(
      `Unknown agent ${name}. Available agents: ${agents.map((candidate) => candidate.name).join(", ")}`,
    );
  }
  return agent;
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

interface RunContext {
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

function formatTokens(value: number): string {
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(1)}k`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${(milliseconds / 1_000).toFixed(1)}s`
    : `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

type Theme = ExtensionContext["ui"]["theme"];

function renderAgent(
  result: AgentResult,
  expanded: boolean,
  theme: Theme,
  display: TranscriptDisplay,
): Container {
  const container = new Container();
  const icon =
    result.progress.status === "running"
      ? theme.fg("warning", "⟳")
      : result.progress.status === "pending"
        ? theme.fg("dim", "○")
        : result.progress.status === "completed"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
  const tokens = result.usage.input + result.usage.output;
  container.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${result.agentSource ? theme.fg("dim", ` [${result.agentSource}]`) : ""} ${theme.fg("dim", `${result.progress.toolCount} tools · ${formatTokens(tokens)} tok · ${formatDuration(result.progress.durationMs)}${result.usage.cost > 0 ? ` · ${formatCost(result.usage.cost)}` : ""}${result.sessionId ? ` · ${result.sessionId}` : ""}`)}`,
      0,
      0,
    ),
  );
  const task = expanded
    ? result.task
    : result.task.replace(/\s+/g, " ").slice(0, 160);

  if (expanded) {
    let transcript: Container | undefined;
    let unavailable: string | undefined;
    try {
      transcript = transcriptView(result, display);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
    // The transcript starts with the task, so it needs no task line.
    if (transcript) {
      container.addChild(transcript);
      addFooter(container, result, theme);
      return container;
    }
    if (unavailable) {
      container.addChild(
        new Text(
          theme.fg("warning", `Transcript unavailable: ${unavailable}`),
          0,
          0,
        ),
      );
    }
  }
  container.addChild(new Text(theme.fg("dim", `Task: ${task}`), 0, 0));

  const tools = expanded
    ? result.progress.recentTools
    : result.progress.recentTools.slice(-5);
  for (const tool of tools) {
    container.addChild(
      new Text(theme.fg("muted", `  ${tool.tool}: ${tool.args}`), 0, 0),
    );
  }
  if (result.progress.currentTool) {
    container.addChild(
      new Text(
        theme.fg(
          "warning",
          `▸ ${result.progress.currentTool}: ${result.progress.currentToolArgs ?? ""}`,
        ),
        0,
        0,
      ),
    );
  }
  if (expanded && result.output && result.progress.status !== "running") {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(result.output, 0, 0, getMarkdownTheme()));
  } else if (result.progress.lastMessage) {
    container.addChild(
      new Text(theme.fg("text", result.progress.lastMessage), 0, 0),
    );
  }
  addFooter(container, result, theme, expanded);
  return container;
}

function addFooter(
  container: Container,
  result: AgentResult,
  theme: Theme,
  showSession = true,
): void {
  if (result.progress.error) {
    container.addChild(
      new Text(theme.fg("error", `Error: ${result.progress.error}`), 0, 0),
    );
  }
  if (result.progress.warning) {
    container.addChild(
      new Text(
        theme.fg("warning", `Warning: ${result.progress.warning}`),
        0,
        0,
      ),
    );
  }
  if (showSession && result.sessionFile) {
    container.addChild(
      new Text(theme.fg("dim", `Session: ${result.sessionFile}`), 0, 0),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          `Work in it yourself: /agents open ${result.sessionId}`,
        ),
        0,
        0,
      ),
    );
  }
}

/** The text the parent model receives for one subagent run. */
export function resultText(result: AgentResult): string {
  let text = result.output || "(no output)";
  if (result.userMessages?.length) {
    const messages = result.userMessages.map((message) => `- ${message}`);
    text += `\n\nThe user sent the subagent these messages while it ran:\n${messages.join("\n")}`;
  }
  if (result.sessionFile) text += `\n\nSession: ${result.sessionId}`;
  return text;
}

/** The text the parent model receives for one tool call's runs. */
export function combinedText(details: SubagentDetails): string {
  if (details.mode === "single") return resultText(details.results[0]);
  return details.results
    .map(
      (result) =>
        `## ${result.agent}${result.progress.status === "failed" ? " (FAILED)" : ""}\n\n${resultText(result)}`,
    )
    .join("\n\n---\n\n");
}

function backgroundText(results: AgentResult[]): string {
  const ids = results.map((result) => result.sessionId).join(", ");
  return `Started in the background: ${ids}. The result arrives as a message when ${results.length > 1 ? "all of them end" : "the run ends"}. Continue with other work; do not wait or poll for it. The user can follow it with /agents.`;
}

export function renderDetails(
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme,
  display: TranscriptDisplay,
): Container {
  const container = new Container();
  if (details.background) {
    for (const result of details.results) {
      container.addChild(
        new Text(
          `${theme.fg("accent", "⇢")} ${theme.fg("toolTitle", theme.bold(result.agent))} ${theme.fg("dim", `${result.sessionId ?? ""} started in the background`)}`,
          0,
          0,
        ),
      );
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            `Task: ${result.task.replace(/\s+/g, " ").slice(0, 160)}`,
          ),
          0,
          0,
        ),
      );
    }
    container.addChild(
      new Text(theme.fg("dim", "Follow it with /agents."), 0, 0),
    );
    return container;
  }
  if (details.mode === "parallel") {
    const done = details.results.filter(
      (item) => item.progress.status === "completed",
    ).length;
    container.addChild(
      new Text(
        theme.fg(
          "toolTitle",
          theme.bold(`parallel ${done}/${details.results.length}`),
        ),
        0,
        0,
      ),
    );
    container.addChild(new Spacer(1));
  }
  details.results.forEach((item, index) => {
    container.addChild(renderAgent(item, expanded, theme, display));
    if (index < details.results.length - 1) {
      container.addChild(new Spacer(1));
    }
  });
  return container;
}

const SESSION_DESCRIPTION =
  "Session id of an earlier subagent run to continue; task is then the follow-up message";

const TaskSchema = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Agent name; optional with session" }),
  ),
  task: Type.String({ description: "Self-contained task description" }),
  cwd: Type.Optional(
    Type.String({
      description: "Subagent working directory; not allowed with session",
    }),
  ),
  session: Type.Optional(Type.String({ description: SESSION_DESCRIPTION })),
});

/**
 * A run that throws becomes a failed result,
 * so every run reaches a final status.
 */
async function runAll(
  plans: RunPlan[],
  runs: SubagentRun[],
  limiter: Limiter,
  context: RunContext,
  update: () => void,
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
      return run.result;
    }),
  );
}

/**
 * State every registration of the tool shares. The tool is registered again
 * when project agents load, and runs must keep one limit and one queue.
 */
interface ToolServices {
  registry: RunRegistry;
  delivery: Delivery;
  hideThinking: () => boolean;
  // One limit for every run of this session, background runs included.
  limiter: Limiter;
  // Dialogs from all subagents share one queue, so only one is open at a time.
  enqueueDialog: <T>(task: () => Promise<T>) => Promise<T>;
}

function agentLabel(agent: AgentDefinition): string {
  return agent.source === "package"
    ? agent.name
    : `${agent.name} [${agent.source}]`;
}

function extensionTool(
  config: SubagentConfig,
  agents: AgentDefinition[],
  services: ToolServices,
) {
  const { registry, delivery, hideThinking, limiter, enqueueDialog } = services;
  return {
    name: "subagent" as const,
    label: "Subagent",
    description: `Run an isolated subagent. Available agents: ${agents.map((agent) => `${agentLabel(agent)} (${agent.description})`).join(", ")}.`,
    promptSnippet:
      "Delegate reasoning or autonomous work to an isolated subagent",
    promptGuidelines: [
      "Use subagent for delegated reasoning or autonomous work, not to parallelize simple file or web tool calls.",
      "Subagents have no parent conversation context, so every subagent task must include all required context.",
      "Use subagent tasks for independent parallel delegations.",
      "To continue an earlier subagent with its context, pass its session id and a follow-up task instead of restating the context.",
      "Set background: true for long work you do not need right away. The tool returns at once, and the result arrives later as a message; continue with other work and do not poll for it.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({ description: "Agent name in single mode" }),
      ),
      task: Type.Optional(
        Type.String({ description: "Self-contained task in single mode" }),
      ),
      tasks: Type.Optional(
        Type.Array(TaskSchema, {
          description: "Independent tasks for parallel mode",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Subagent working directory in single mode",
        }),
      ),
      session: Type.Optional(
        Type.String({ description: `${SESSION_DESCRIPTION}, in single mode` }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Return at once and deliver the result later as a message",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        agent?: string;
        task?: string;
        tasks?: TaskRequest[];
        cwd?: string;
        session?: string;
        background?: boolean;
      },
      signal: AbortSignal | undefined,
      onUpdate:
        | ((result: {
            content: Array<{ type: "text"; text: string }>;
            details: SubagentDetails;
          }) => void)
        | undefined,
      ctx: {
        cwd: string;
        model?: { provider: string; id: string };
        modelRegistry: {
          getAvailable(): Array<{ provider: string; id: string }>;
        };
        thinkingLevel?: string;
        hasUI: boolean;
        ui: ParentUI;
      },
    ) {
      const hasParallel = Boolean(params.tasks?.length);
      const hasSingle = Boolean(
        params.task && (params.agent || params.session),
      );
      if (Number(hasParallel) + Number(hasSingle) !== 1) {
        throw new Error(
          "Provide exactly one mode: agent or session + task, or tasks",
        );
      }
      const mode = hasParallel ? "parallel" : "single";
      const requests: TaskRequest[] = params.tasks?.length
        ? params.tasks
        : [
            {
              agent: params.agent,
              task: params.task as string,
              cwd: params.cwd,
              session: params.session,
            },
          ];
      if (requests.length > config.maxParallelTasks) {
        throw new Error(
          `At most ${config.maxParallelTasks} parallel subagent tasks are allowed`,
        );
      }
      const plans = requests.map((request) =>
        planRun(request, agents, ctx.cwd),
      );
      const ids = plans.map((plan) => plan.target.id);
      ids.forEach((id, index) => {
        if (registry.active(id) || ids.indexOf(id) !== index) {
          throw new Error(`Subagent session ${id} is already running`);
        }
      });

      const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      const availableModels = new Set(
        ctx.modelRegistry
          .getAvailable()
          .map((model) => `${model.provider}/${model.id}`),
      );
      const runs: SubagentRun[] = plans.map((plan) => ({
        result: {
          ...pendingResult(plan.agent.name, plan.task, plan.target.id),
          ...(plan.agent.source === "package"
            ? {}
            : { agentSource: plan.agent.source }),
        },
        stop: new AbortController(),
        pendingDialogs: [],
      }));
      const update = () => {
        registry.changed();
        onUpdate?.({
          content: [
            {
              type: "text",
              text:
                mode === "parallel"
                  ? `Running ${plans.length} subagents`
                  : "Running subagent",
            },
          ],
          details: { mode, results: runs.map((run) => run.result) },
        });
      };

      for (const run of runs) registry.add(run);
      const context: RunContext = {
        parentModel,
        availableModels,
        thinkingLevel: ctx.thinkingLevel,
        signal,
        ui: ctx.hasUI ? ctx.ui : undefined,
        enqueueDialog,
        background: params.background === true,
        registry,
        questionTimeoutMs: config.backgroundQuestionTimeoutMinutes * 60_000,
      };

      if (params.background) {
        // The runs outlive this tool call, so its signal must not stop them.
        const token = delivery.start();
        void runAll(
          plans,
          runs,
          limiter,
          { ...context, signal: undefined },
          () => registry.changed(),
        ).then((results) => delivery.deliver(token, { mode, results }));
        const started = runs.map((run) => run.result);
        return {
          content: [{ type: "text" as const, text: backgroundText(started) }],
          details: {
            mode,
            background: true,
            results: started.map(({ agent, task, sessionId }) => ({
              ...pendingResult(agent, task, sessionId ?? ""),
            })),
          } as SubagentDetails,
        };
      }

      const results = await runAll(plans, runs, limiter, context, update);
      const details: SubagentDetails = { mode, results };
      return {
        content: [{ type: "text" as const, text: combinedText(details) }],
        details,
      };
    },
    renderCall(
      args: {
        agent?: string;
        task?: string;
        tasks?: TaskRequest[];
        session?: string;
        background?: boolean;
      },
      theme: {
        bold(text: string): string;
        fg(color: "toolTitle" | "accent" | "dim", text: string): string;
      },
    ) {
      const background = args.background
        ? ` ${theme.fg("dim", "(background)")}`
        : "";
      if (args.tasks?.length) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks)`)}${background}`,
          0,
          0,
        );
      }
      const agent =
        args.agent ?? (args.session ? sessionAgent(args.session) : undefined);
      const resume = args.session
        ? ` ${theme.fg("dim", `(continues ${args.session})`)}`
        : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", agent ?? "")}${resume}${background}`,
        0,
        0,
      );
    },
    renderResult(
      result: {
        content: Array<{ type: string; text?: string }>;
        details?: unknown;
      },
      options: { expanded: boolean },
      theme: Theme,
      context: { invalidate: () => void },
    ) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length) {
        return new Text(result.content[0]?.text ?? "(no output)", 0, 0);
      }
      return renderDetails(details, options.expanded, theme, {
        invalidate: context.invalidate,
        hideThinking: hideThinking(),
      });
    },
  };
}

export default function subagents(
  pi: ExtensionAPI,
  registry: RunRegistry = new RunRegistry(),
): void {
  const config = loadConfig();
  const agents = loadAgents(config);
  // Tokens of background calls that may still deliver to this session.
  const pending = new Set<{ cancelled: boolean }>();
  const delivery: Delivery = {
    start() {
      const token = { cancelled: false };
      pending.add(token);
      return token;
    },
    deliver(token, details) {
      pending.delete(token);
      if (token.cancelled) return;
      pi.sendMessage(
        {
          customType: RESULT_MESSAGE_TYPE,
          content: `Background subagent result:\n\n${combinedText(details)}`,
          display: true,
          details,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  };
  // Follows the user's setting, which the TUI also changes at runtime.
  const hideThinking = () => pi.getSettings().hideThinkingBlock === true;
  const services: ToolServices = {
    registry,
    delivery,
    hideThinking,
    limiter: new Limiter(config.maxConcurrency),
    enqueueDialog: createDialogQueue(),
  };
  pi.registerTool(extensionTool(config, agents, services));

  // Project agents depend on the working directory and on project trust,
  // which only a session knows.
  pi.on("session_start", (_event, ctx) => {
    const directory = projectAgentsDir(ctx.cwd);
    if (!existsSync(directory)) return;
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify(
        `${directory}: project agents were not loaded because this project is not trusted`,
        "warning",
      );
      return;
    }
    try {
      const project = readAgentDir(directory, "project", config);
      if (project.length === 0) return;
      pi.registerTool(
        extensionTool(config, mergeAgents(agents, project), services),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Project agents were not loaded: ${message}`, "error");
    }
  });
  pi.registerMessageRenderer<SubagentDetails>(
    RESULT_MESSAGE_TYPE,
    (message, options, theme) => {
      const container = new Container();
      container.addChild(
        new Text(
          theme.fg("toolTitle", theme.bold("Background subagent finished")),
          0,
          0,
        ),
      );
      if (message.details?.results.length) {
        container.addChild(
          renderDetails(message.details, options.expanded, theme, {
            invalidate: () => {},
            hideThinking: hideThinking(),
          }),
        );
      }
      return container;
    },
  );
  pi.on("session_shutdown", () => {
    for (const token of pending) token.cancelled = true;
    pending.clear();
    for (const run of registry.list()) registry.stop(run);
  });

  pi.registerCommand("agents", {
    description:
      "Follow subagents; `open <id>` switches to a subagent session, `back` returns",
    getArgumentCompletions: (prefix) => {
      if (prefix.startsWith("open ")) {
        const typed = prefix.slice("open ".length);
        return listSavedSessions(SAVED_SESSION_LIMIT)
          .filter((session) => session.id.startsWith(typed))
          .map((session) => ({
            value: `open ${session.id}`,
            label: session.id,
            description: session.name,
          }));
      }
      return [
        {
          value: "open ",
          label: "open",
          description: "Open a subagent session",
        },
        {
          value: "back",
          label: "back",
          description: "Return to the parent session",
        },
      ].filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const [action, id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "open" && id && rest.length === 0) {
        await openSubagentSession(ctx, registry, id);
        return;
      }
      if (action === "back" && !id) {
        await returnToParent(ctx);
        return;
      }
      if (action) {
        ctx.ui.notify(
          "Usage: /agents, /agents open <id>, or /agents back",
          "warning",
        );
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The agents overlay requires TUI mode", "warning");
        return;
      }
      const choice = await ctx.ui.custom<OverlayChoice>(
        (tui, theme, _keybindings, done) =>
          new AgentsOverlay(tui, theme, registry, done, {
            hideThinking,
            savedSessions: () => listSavedSessions(SAVED_SESSION_LIMIT),
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            minWidth: 60,
            maxHeight: "90%",
          },
        },
      );
      if (choice) await openSubagentSession(ctx, registry, choice.open);
    },
  });

  let savedCost = 0;
  let savedKeys = new Set<string>();
  let reportedCost: number | undefined;
  const reportCost = () => {
    const unsaved = registry
      .list()
      .filter((run) => !savedKeys.has(resultKey(run.result)))
      .reduce((sum, run) => sum + run.result.usage.cost, 0);
    const cost = savedCost + unsaved;
    if (cost === reportedCost) return;
    reportedCost = cost;
    pi.events.emit(SUBAGENT_COST_CHANNEL, { cost } satisfies SubagentCostEvent);
  };
  const branchRuns = (entries: readonly unknown[]) => {
    const runs = savedRuns(entries, RESULT_MESSAGE_TYPE);
    // A result can appear twice when a message is both saved and pending.
    const costs = new Map(
      runs.map((run) => [resultKey(run.result), run.result.usage.cost]),
    );
    savedKeys = new Set(costs.keys());
    savedCost = [...costs.values()].reduce((sum, cost) => sum + cost, 0);
    reportCost();
    return runs;
  };
  registry.subscribe(reportCost);
  pi.on("session_tree", (_event, ctx) => {
    branchRuns(ctx.sessionManager.getBranch());
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message as {
      role?: string;
      toolName?: string;
      customType?: string;
      details?: unknown;
    };
    // Pi saves a message after extensions see its message_end, so the
    // message joins the saved entries here.
    let entry: unknown;
    if (message.role === "toolResult" && message.toolName === "subagent") {
      entry = { type: "message", message };
    } else if (
      message.role === "custom" &&
      message.customType === RESULT_MESSAGE_TYPE
    ) {
      entry = {
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      };
    }
    if (entry) branchRuns([...ctx.sessionManager.getBranch(), entry]);
  });

  let pruned = false;
  pi.on("session_start", (_event, ctx) => {
    const runs = branchRuns(ctx.sessionManager.getBranch());
    // A reload or a session switch starts with an empty registry.
    if (registry.list().length === 0) {
      for (const run of runs) registry.add(run);
    }
    if (pruned) return;
    pruned = true;
    pruneSessions(config.sessionRetentionDays).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Subagent session cleanup failed: ${message}`, "warning");
    });
  });
}
