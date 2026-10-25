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
import { RpcChild, type RpcRecord } from "./rpc.ts";
import {
  AGENT_NAME_PATTERN,
  findSession,
  newSessionId,
  pruneSessions,
  readSessionCwd,
  SESSIONS_DIR,
  type SessionTarget,
  sessionAgent,
  sessionArguments,
  sessionName,
} from "./sessions.ts";

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
};

interface AgentModelConfig {
  models: string[];
}

interface SubagentConfig {
  maxConcurrency: number;
  maxParallelTasks: number;
  sessionRetentionDays: number;
  agents: Record<string, AgentModelConfig>;
}

interface AgentDefinition {
  name: string;
  description: string;
  tools: string[];
  modelPreferences: string[];
  systemPrompt: string;
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
}

interface AgentResult {
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
}

interface SubagentDetails {
  mode: "single" | "parallel";
  results: AgentResult[];
}

interface JsonEvent {
  type?: unknown;
  toolName?: unknown;
  args?: unknown;
  message?: unknown;
}

export const DEFAULT_CONFIG: SubagentConfig = {
  maxConcurrency: 4,
  maxParallelTasks: 8,
  sessionRetentionDays: 90,
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

function loadAgents(config: SubagentConfig): AgentDefinition[] {
  const names = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR) : [];
  const agents = names
    .filter((name) => name.endsWith(".md"))
    .map((name): AgentDefinition | null => {
      const content = readFileSync(join(AGENTS_DIR, name), "utf8");
      const { frontmatter, body } =
        parseFrontmatter<Record<string, unknown>>(content);
      if (
        typeof frontmatter.name !== "string" ||
        typeof frontmatter.description !== "string"
      ) {
        return null;
      }
      const configured = config.agents[frontmatter.name] ?? { models: [] };
      const tools = assertSupportedTools(name, parseTools(frontmatter.tools));
      return {
        name: assertAgentName(name, frontmatter.name),
        description: frontmatter.description,
        tools,
        modelPreferences: configured.models,
        systemPrompt: body,
      };
    })
    .filter((agent): agent is AgentDefinition => agent !== null);

  const loadedNames = new Set(agents.map((agent) => agent.name));
  if (loadedNames.size !== agents.length) {
    throw new Error(`${AGENTS_DIR}: agent names must be unique`);
  }
  if (agents.length === 0) {
    throw new Error(`${AGENTS_DIR}: no valid agent definitions found`);
  }
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

function applyEvent(result: AgentResult, record: RpcRecord): void {
  const event = record as JsonEvent;
  if (event.type === "tool_execution_start") {
    result.progress.toolCount += 1;
    result.progress.currentTool =
      typeof event.toolName === "string" ? event.toolName : "tool";
    result.progress.currentToolArgs = toolArgsPreview(event.args);
    return;
  }
  if (event.type === "tool_execution_end") {
    if (result.progress.currentTool) {
      result.progress.recentTools.push({
        tool: result.progress.currentTool,
        args: result.progress.currentToolArgs ?? "",
      });
      result.progress.recentTools = result.progress.recentTools.slice(-20);
    }
    result.progress.currentTool = undefined;
    result.progress.currentToolArgs = undefined;
    return;
  }
  if (event.type !== "message_end" || !isRecord(event.message)) return;
  if (event.message.role !== "assistant") return;

  result.usage.turns += 1;
  addUsage(result.usage, event.message.usage);
  if (typeof event.message.model === "string") {
    result.model = event.message.model;
  }
  if (typeof event.message.errorMessage === "string") {
    result.progress.error = event.message.errorMessage;
  }
  if (
    event.message.stopReason === "error" ||
    event.message.stopReason === "aborted"
  ) {
    result.progress.error ??= `Agent stopped: ${event.message.stopReason}`;
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

async function runAgent(
  plan: RunPlan,
  parentModel: string | undefined,
  availableModels: ReadonlySet<string>,
  thinkingLevel: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: (result: AgentResult) => void,
): Promise<AgentResult> {
  const { agent, task, cwd, target } = plan;
  const result = pendingResult(agent.name, task, target.id);
  const selectedModel = selectSubagentModel(
    agent.modelPreferences,
    availableModels,
    parentModel,
  );
  const inheritThinkingLevel =
    selectedModel !== undefined && selectedModel === parentModel;
  result.model = selectedModel;
  result.progress.status = "running";
  const startedAt = Date.now();

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
      ),
    );
    const child = new RpcChild(invocation.command, invocation.args, cwd);

    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    child.onRecord((record) => {
      if (record.type === "agent_settled") {
        settle();
        return;
      }
      applyEvent(result, record);
      result.progress.durationMs = Date.now() - startedAt;
      onUpdate?.(result);
    });

    const abort = () => void child.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
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
      signal?.removeEventListener("abort", abort);
      result.exitCode = await child.close();
    }
    result.sessionFile =
      target.kind === "resume" ? target.path : findSession(target.id);
    if (result.exitCode !== 0 && !result.progress.error && child.stderr()) {
      result.progress.error = child.stderr();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  if (signal?.aborted) result.progress.error = "Subagent was aborted";

  result.progress.durationMs = Date.now() - startedAt;
  result.progress.status =
    result.exitCode === 0 && !result.progress.error ? "completed" : "failed";
  if (!result.output && result.progress.error) {
    result.output = `Error: ${result.progress.error}`;
  }
  const truncated = truncateHead(result.output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  result.output = truncated.content;
  if (truncated.truncated) result.output += "\n\n[Subagent output truncated]";
  onUpdate?.(result);
  return result;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
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
      `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))} ${theme.fg("dim", `${result.progress.toolCount} tools · ${formatTokens(tokens)} tok · ${formatDuration(result.progress.durationMs)}${result.sessionId ? ` · ${result.sessionId}` : ""}`)}`,
      0,
      0,
    ),
  );
  const task = expanded
    ? result.task
    : result.task.replace(/\s+/g, " ").slice(0, 160);
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
  if (result.progress.error) {
    container.addChild(
      new Text(theme.fg("error", `Error: ${result.progress.error}`), 0, 0),
    );
  }
  if (expanded && result.sessionFile) {
    container.addChild(
      new Text(theme.fg("dim", `Session: ${result.sessionFile}`), 0, 0),
    );
  }
  return container;
}

/** The text the parent model receives for one subagent run. */
function resultText(result: AgentResult): string {
  const output = result.output || "(no output)";
  return result.sessionFile
    ? `${output}\n\nSession: ${result.sessionId}`
    : output;
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

function extensionTool(config: SubagentConfig, agents: AgentDefinition[]) {
  // Ids of sessions with a live child; one session runs in one child.
  const running = new Set<string>();
  return {
    name: "subagent" as const,
    label: "Subagent",
    description: `Run an isolated subagent. Available agents: ${agents.map((agent) => `${agent.name} (${agent.description})`).join(", ")}.`,
    promptSnippet:
      "Delegate reasoning or autonomous work to an isolated subagent",
    promptGuidelines: [
      "Use subagent for delegated reasoning or autonomous work, not to parallelize simple file or web tool calls.",
      "Subagents have no parent conversation context, so every subagent task must include all required context.",
      "Use subagent tasks for independent parallel delegations.",
      "To continue an earlier subagent with its context, pass its session id and a follow-up task instead of restating the context.",
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
    }),
    async execute(
      _toolCallId: string,
      params: {
        agent?: string;
        task?: string;
        tasks?: TaskRequest[];
        cwd?: string;
        session?: string;
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
        if (running.has(id) || ids.indexOf(id) !== index) {
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
      const liveResults = plans.map((plan) =>
        pendingResult(plan.agent.name, plan.task, plan.target.id),
      );
      const update = () =>
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
          details: { mode, results: [...liveResults] },
        });

      for (const id of ids) running.add(id);
      try {
        const results = await mapConcurrent(
          plans,
          config.maxConcurrency,
          async (plan, index) => {
            const result = await runAgent(
              plan,
              parentModel,
              availableModels,
              ctx.thinkingLevel,
              signal,
              (current) => {
                liveResults[index] = current;
                update();
              },
            );
            liveResults[index] = result;
            update();
            return result;
          },
        );
        const text =
          mode === "single"
            ? resultText(results[0])
            : results
                .map(
                  (result) =>
                    `## ${result.agent}${result.progress.status === "failed" ? " (FAILED)" : ""}\n\n${resultText(result)}`,
                )
                .join("\n\n---\n\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { mode, results } as SubagentDetails,
        };
      } finally {
        for (const id of ids) running.delete(id);
      }
    },
    renderCall(
      args: {
        agent?: string;
        task?: string;
        tasks?: TaskRequest[];
        session?: string;
      },
      theme: {
        bold(text: string): string;
        fg(color: "toolTitle" | "accent" | "dim", text: string): string;
      },
    ) {
      if (args.tasks?.length) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks)`)}`,
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
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", agent ?? "")}${resume}`,
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
    ) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length) {
        return new Text(result.content[0]?.text ?? "(no output)", 0, 0);
      }
      const container = new Container();
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
        container.addChild(renderAgent(item, options.expanded, theme));
        if (index < details.results.length - 1) {
          container.addChild(new Spacer(1));
        }
      });
      return container;
    },
  };
}

export default function subagents(pi: ExtensionAPI): void {
  const config = loadConfig();
  const agents = loadAgents(config);
  pi.registerTool(extensionTool(config, agents));

  let pruned = false;
  pi.on("session_start", (_event, ctx) => {
    if (pruned) return;
    pruned = true;
    pruneSessions(config.sessionRetentionDays).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Subagent session cleanup failed: ${message}`, "warning");
    });
  });
}
