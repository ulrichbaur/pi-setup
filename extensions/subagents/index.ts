import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  SUBAGENT_COST_CHANNEL,
  type SubagentCostEvent,
} from "../../lib/subagent-cost.ts";
import { loadAgents } from "./agents.ts";
import { AgentsOverlay } from "./agents-view.ts";
import { loadConfig } from "./config.ts";
import { Limiter } from "./limiter.ts";
import { combinedText, renderDetails } from "./render.ts";
import { resultKey, savedRuns } from "./restore.ts";
import { RunRegistry } from "./runs.ts";
import { pruneSessions } from "./sessions.ts";
import { extensionTool, type ToolServices } from "./tool.ts";
import {
  type Delivery,
  RESULT_MESSAGE_TYPE,
  type SubagentDetails,
} from "./types.ts";

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
  };
  pi.registerTool(extensionTool(config, agents, services));

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
    description: "List subagents, inspect live transcripts, or stop a run",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /agents", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The agents overlay requires TUI mode", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new AgentsOverlay(tui, theme, registry, done, { hideThinking }),
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
