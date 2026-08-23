import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
  analyzeBashCommand,
  type BashRisk,
  headlessBlockReason,
} from "./policy.ts";
import { BashReviewComponent } from "./review.ts";

const ABORT_REMEMBER_MS = 60_000;

async function promptForCommand(
  ctx: ExtensionContext,
  command: string,
  risk: BashRisk,
): Promise<boolean> {
  const reasons = risk.reasons.map((reason) => `• ${reason}`).join("\n");
  const message = `${reasons}\n\nCommand:\n${command}`;

  if (ctx.mode !== "tui") {
    return ctx.ui.confirm(
      `${risk.severity.toUpperCase()} risk bash command`,
      message,
    );
  }

  const choice = await ctx.ui.custom<"abort" | "run">(
    (tui, theme, _keybindings, done) =>
      new BashReviewComponent(tui, theme, risk, command, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 48,
        maxHeight: "85%",
      },
    },
  );
  return choice === "run";
}

function subagentDepth(): number {
  const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  return Number.isFinite(depth) && depth >= 1 ? depth : 0;
}

export default function bashGuard(pi: ExtensionAPI): void {
  if (subagentDepth() >= 1) {
    pi.on("tool_call", async (event) => {
      if (!isToolCallEventType("bash", event)) return;
      const reason = headlessBlockReason(event.input.command);
      if (!reason) return;
      return {
        block: true,
        reason: `Blocked by bash-guard in a non-interactive subagent: ${reason}. Ask the parent agent to perform or confirm this operation.`,
      };
    });
    return;
  }

  pi.registerFlag("bash-guard-auto-allow", {
    description:
      "Allow flagged bash commands when interactive confirmation is unavailable",
    type: "boolean",
    default: false,
  });

  const recentlyAborted = new Map<string, number>();
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;
    const risk = analyzeBashCommand(command);
    if (!risk) return;

    const previousAbort = recentlyAborted.get(command);
    if (
      previousAbort !== undefined &&
      Date.now() - previousAbort < ABORT_REMEMBER_MS
    ) {
      return {
        block: true,
        reason:
          "Blocked by bash-guard because the same command was aborted recently. Do not retry it unchanged.",
      };
    }

    if (!ctx.hasUI) {
      if (pi.getFlag("bash-guard-auto-allow") === true) return;
      return {
        block: true,
        reason: `Blocked by bash-guard because confirmation is unavailable: ${risk.reasons.join("; ")}.`,
      };
    }

    if (await promptForCommand(ctx, command, risk)) return;
    recentlyAborted.set(command, Date.now());
    return {
      block: true,
      reason:
        "Blocked by the user through bash-guard. Propose a safer command or ask before trying a materially different operation.",
    };
  });
}
