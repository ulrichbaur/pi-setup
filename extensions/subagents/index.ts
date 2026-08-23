import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  parseFrontmatter,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(EXTENSION_DIR, "agents");
const CONFIG_PATH = join(EXTENSION_DIR, "config.json");
const BUILTIN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  safe_bash: join(EXTENSION_DIR, "tools", "safe-bash.ts"),
  web_fetch: join(EXTENSION_DIR, "..", "web-fetch", "index.ts"),
  web_search: join(EXTENSION_DIR, "..", "web-search", "index.ts"),
};
const TASK_ARGUMENT_LIMIT = 8_000;

interface AgentModelConfig {
  models: string[];
}

interface SubagentConfig {
  maxConcurrency: number;
  maxParallelTasks: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${CONFIG_PATH}: ${field} must be a positive integer`);
  }
  return value as number;
}

export function parseSubagentConfig(value: unknown): SubagentConfig {
  if (!isRecord(value) || !isRecord(value.agents)) {
    throw new Error(`${CONFIG_PATH}: expected an object with an agents object`);
  }

  const agents: Record<string, AgentModelConfig> = {};
  for (const [name, agentValue] of Object.entries(value.agents)) {
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
    maxConcurrency: positiveInteger(value.maxConcurrency, "maxConcurrency"),
    maxParallelTasks: positiveInteger(
      value.maxParallelTasks,
      "maxParallelTasks",
    ),
    agents,
  };
}

function loadConfig(): SubagentConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Missing required subagent config: ${CONFIG_PATH}`);
  }
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
      const configured = config.agents[frontmatter.name];
      if (!configured) {
        throw new Error(
          `${CONFIG_PATH}: missing agents.${frontmatter.name} for ${name}`,
        );
      }
      const tools = parseTools(frontmatter.tools);
      for (const tool of tools) {
        if (!BUILTIN_TOOLS.has(tool) && !CUSTOM_TOOL_EXTENSIONS[tool]) {
          throw new Error(`${name}: unsupported subagent tool ${tool}`);
        }
      }
      return {
        name: frontmatter.name,
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

function pendingResult(agent: string, task: string): AgentResult {
  return {
    agent,
    task,
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

function applyEvent(result: AgentResult, line: string): void {
  let event: JsonEvent;
  try {
    event = JSON.parse(line) as JsonEvent;
  } catch {
    return;
  }

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

async function buildArguments(
  agent: AgentDefinition,
  task: string,
  selectedModel: string | undefined,
  inheritThinkingLevel: boolean,
  thinkingLevel: string | undefined,
): Promise<{ args: string[]; temporaryDirectory: string }> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const promptPath = join(temporaryDirectory, `${agent.name}.md`);
  await writeFile(promptPath, agent.systemPrompt, {
    encoding: "utf8",
    mode: 0o600,
  });

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-skills",
    "--no-extensions",
  ];
  args.push(...subagentToolSelectionArgs(agent.tools));

  const extensionPaths = new Set(
    agent.tools
      .map((tool) => CUSTOM_TOOL_EXTENSIONS[tool])
      .filter((extension): extension is string => Boolean(extension)),
  );
  for (const extensionPath of extensionPaths) {
    args.push("--extension", extensionPath);
  }

  if (selectedModel) args.push("--model", selectedModel);
  if (inheritThinkingLevel && thinkingLevel && thinkingLevel !== "off") {
    args.push("--thinking", thinkingLevel);
  }
  args.push("--append-system-prompt", promptPath);

  if (task.length <= TASK_ARGUMENT_LIMIT) {
    args.push(`Task: ${task}`);
  } else {
    const taskPath = join(temporaryDirectory, "task.md");
    await writeFile(taskPath, `Task: ${task}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    args.push(`@${taskPath}`);
  }
  return { args, temporaryDirectory };
}

async function runAgent(
  agent: AgentDefinition,
  task: string,
  cwd: string,
  parentModel: string | undefined,
  availableModels: ReadonlySet<string>,
  thinkingLevel: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: (result: AgentResult) => void,
): Promise<AgentResult> {
  const result = pendingResult(agent.name, task);
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
  const { args, temporaryDirectory } = await buildArguments(
    agent,
    task,
    selectedModel,
    inheritThinkingLevel,
    thinkingLevel,
  );
  const invocation = resolvePiInvocation(args);

  try {
    result.exitCode = await new Promise<number>((resolve) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let killTimer: NodeJS.Timeout | undefined;

      const update = () => {
        result.progress.durationMs = Date.now() - startedAt;
        onUpdate?.(result);
      };
      const processLine = (line: string) => {
        if (!line.trim()) return;
        applyEvent(result, line);
        update();
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const abort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 3_000);
        killTimer.unref();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (error) => {
        result.progress.error = error.message;
      });
      child.on("close", (code) => {
        if (stdout.trim()) processLine(stdout);
        if (code !== 0 && stderr.trim() && !result.progress.error) {
          result.progress.error = stderr.trim();
        }
        if (signal?.aborted) result.progress.error = "Subagent was aborted";
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        resolve(code ?? 1);
      });
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

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
      `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))} ${theme.fg("dim", `${result.progress.toolCount} tools · ${formatTokens(tokens)} tok · ${formatDuration(result.progress.durationMs)}`)}`,
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
  return container;
}

const TaskSchema = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Self-contained task description" }),
  cwd: Type.Optional(
    Type.String({ description: "Subagent working directory" }),
  ),
});

function extensionTool(config: SubagentConfig, agents: AgentDefinition[]) {
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
    }),
    async execute(
      _toolCallId: string,
      params: {
        agent?: string;
        task?: string;
        tasks?: Array<{ agent: string; task: string; cwd?: string }>;
        cwd?: string;
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
      const hasSingle = Boolean(params.agent && params.task);
      if (Number(hasParallel) + Number(hasSingle) !== 1) {
        throw new Error("Provide exactly one mode: agent + task, or tasks");
      }
      const parentModel = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : undefined;
      const availableModels = new Set(
        ctx.modelRegistry
          .getAvailable()
          .map((model) => `${model.provider}/${model.id}`),
      );
      const findAgent = (name: string) => {
        const agent = agents.find((candidate) => candidate.name === name);
        if (!agent) {
          throw new Error(
            `Unknown agent ${name}. Available agents: ${agents.map((candidate) => candidate.name).join(", ")}`,
          );
        }
        return agent;
      };

      if (params.tasks?.length) {
        if (params.tasks.length > config.maxParallelTasks) {
          throw new Error(
            `At most ${config.maxParallelTasks} parallel subagent tasks are allowed`,
          );
        }
        for (const task of params.tasks) findAgent(task.agent);
        const liveResults = params.tasks.map((task) =>
          pendingResult(task.agent, task.task),
        );
        const update = () =>
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Running ${params.tasks?.length ?? 0} subagents`,
              },
            ],
            details: { mode: "parallel", results: [...liveResults] },
          });
        const results = await mapConcurrent(
          params.tasks,
          config.maxConcurrency,
          async (task, index) => {
            const result = await runAgent(
              findAgent(task.agent),
              task.task,
              task.cwd ?? ctx.cwd,
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
        const content = results
          .map(
            (result) =>
              `## ${result.agent}${result.progress.status === "failed" ? " (FAILED)" : ""}\n\n${result.output || "(no output)"}`,
          )
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text" as const, text: content }],
          details: { mode: "parallel" as const, results },
        };
      }

      const agent = findAgent(params.agent as string);
      const result = await runAgent(
        agent,
        params.task as string,
        params.cwd ?? ctx.cwd,
        parentModel,
        availableModels,
        ctx.thinkingLevel,
        signal,
        (current) =>
          onUpdate?.({
            content: [{ type: "text", text: "Running subagent" }],
            details: { mode: "single", results: [current] },
          }),
      );
      return {
        content: [
          { type: "text" as const, text: result.output || "(no output)" },
        ],
        details: { mode: "single" as const, results: [result] },
      };
    },
    renderCall(
      args: {
        agent?: string;
        task?: string;
        tasks?: Array<{ agent: string; task: string }>;
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
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent ?? "")}`,
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
}
