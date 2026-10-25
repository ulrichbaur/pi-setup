import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SubagentConfig } from "./config.ts";
import type { ParentUI } from "./dialogs.ts";
import type { Limiter } from "./limiter.ts";
import {
  backgroundText,
  combinedText,
  renderDetails,
  type Theme,
} from "./render.ts";
import {
  pendingResult,
  planRun,
  type RunContext,
  runAll,
  type TaskRequest,
} from "./run.ts";
import type { RunRegistry, SubagentRun } from "./runs.ts";
import { sessionAgent } from "./sessions.ts";
import type { AgentDefinition, Delivery, SubagentDetails } from "./types.ts";

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
 * State every registration of the tool shares. The tool is registered again
 * when project agents load, and runs must keep one limit and one queue.
 */
export interface ToolServices {
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

export function extensionTool(
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
      "With several background tasks whose results are useful on their own, set deliverEach: true to get each result as soon as its run ends.",
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
      deliverEach: Type.Optional(
        Type.Boolean({
          description:
            "With background tasks, deliver each result when its run ends instead of one message when all end",
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
        deliverEach?: boolean;
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
        const each = params.deliverEach === true && runs.length > 1;
        // The runs outlive this tool call, so its signal must not stop them.
        const background = { ...context, signal: undefined };
        const changed = () => registry.changed();
        if (each) {
          // One token per run, so a shutdown cancels every pending result.
          const tokens = runs.map(() => delivery.start());
          void runAll(plans, runs, limiter, background, changed, (result, i) =>
            delivery.deliver(
              tokens[i],
              { mode: "single", results: [result] },
              `Background subagent result (${result.agent}, task ${i + 1} of ${runs.length})`,
            ),
          );
        } else {
          const token = delivery.start();
          void runAll(plans, runs, limiter, background, changed).then(
            (results) => delivery.deliver(token, { mode, results }),
          );
        }
        const started = runs.map((run) => run.result);
        return {
          content: [
            { type: "text" as const, text: backgroundText(started, each) },
          ],
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
