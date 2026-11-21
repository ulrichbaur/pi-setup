import { randomUUID } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMER_MS,
} from "../../../lib/background-timeout.ts";
import type { SubagentConfig } from "./config.ts";
import type { Limiter } from "./limiter.ts";
import {
  backgroundText,
  combinedText,
  renderDetails,
  type Theme,
} from "./render.ts";
import {
  type ParentUI,
  pendingResult,
  planRun,
  type RunContext,
  runAll,
  runOne,
  type TaskRequest,
} from "./run.ts";
import { type RunRegistry, type SubagentRun, stoppedBy } from "./runs.ts";
import { sessionAgent } from "./sessions.ts";
import type { AgentDefinition, Delivery, SubagentDetails } from "./types.ts";

const SESSION_DESCRIPTION =
  "Session id of an earlier subagent run to continue; task is then the follow-up message";

const timeoutSchema = (description: string) =>
  Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_TIMER_MS,
      description,
    }),
  );

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
  timeoutMs: timeoutSchema(
    "Override the runtime limit for this task. Use 0 to disable it.",
  ),
});

/** State shared by all foreground and background calls. */
export interface ToolServices {
  registry: RunRegistry;
  delivery: Delivery;
  hideThinking: () => boolean;
  // One limit for every run of this session, background runs included.
  limiter: Limiter;
}

export function extensionTool(
  config: SubagentConfig,
  agents: AgentDefinition[],
  services: ToolServices,
) {
  const { registry, delivery, hideThinking, limiter } = services;
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
      "When a subagent result ends with a question, answer it yourself by continuing that subagent with its session id and your answer as the task. Ask the user only when you cannot answer it.",
      "In the terminal and in RPC mode, subagents run in the background: the tool returns at once, and each run's result arrives later as a message. Continue with other work and do not poll for it. In print and JSON mode, the tool waits and returns the results.",
      "Each background subagent run sends its own result, even when launched in parallel. Use subagent_status to check a run only when needed.",
      "Use subagent_stop to stop a background run you no longer need.",
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
      timeoutMs: timeoutSchema(
        `Maximum runtime in milliseconds for each subagent. Defaults to ${DEFAULT_TIMEOUT_MS} (30 minutes). Use 0 to disable it.`,
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
        timeoutMs?: number;
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
        mode: "tui" | "rpc" | "json" | "print";
        hasUI: boolean;
        ui: ParentUI;
      },
    ) {
      // The terminal and RPC clients stay open for later messages. Print and
      // JSON mode exit after the answer, which would stop a background run.
      const background = ctx.mode === "tui" || ctx.mode === "rpc";
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
      for (const timeoutMs of [
        params.timeoutMs,
        ...requests.map((request) => request.timeoutMs),
      ]) {
        if (timeoutMs === undefined) continue;
        if (
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 0 ||
          timeoutMs > MAX_TIMER_MS
        ) {
          throw new Error(
            `timeoutMs must be an integer from 0 to ${MAX_TIMER_MS}`,
          );
        }
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
        result: pendingResult(
          plan.agent.name,
          plan.task,
          plan.target.id,
          background ? randomUUID() : undefined,
        ),
        stop: new AbortController(),
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
      };

      const timeouts = requests.map(
        (request) =>
          request.timeoutMs ?? params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      if (background) {
        // The runs outlive this tool call, so its signal must not stop them.
        const detached = { ...context, signal: undefined };
        const started = runs.map((run, index) => {
          const token = delivery.start();
          // A run's notifications end with its session, like its delivery.
          const parent = context.ui;
          const ui: ParentUI | undefined = parent && {
            notify: (message, type) => {
              if (!token.cancelled) parent.notify(message, type);
            },
          };
          void runOne(
            plans[index],
            run,
            limiter,
            { ...detached, ui },
            () => registry.changed(),
            timeouts[index],
          ).then((result) =>
            // A stopped run does not wake the parent: the user chose to
            // stop it, or subagent_stop already reported the outcome.
            delivery.deliver(
              token,
              { mode: "single", results: [result] },
              { triggerTurn: stoppedBy(run) === undefined },
            ),
          );
          const { agent, task, sessionId, runId } = run.result;
          return pendingResult(agent, task, sessionId, runId);
        });
        return {
          content: [{ type: "text" as const, text: backgroundText(started) }],
          details: {
            mode,
            background: true,
            results: started,
          } as SubagentDetails,
        };
      }

      const results = await runAll(
        plans,
        runs,
        limiter,
        context,
        update,
        timeouts,
      );
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
