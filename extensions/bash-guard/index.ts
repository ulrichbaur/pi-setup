import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { analyzeBashCommand, type BashRisk } from "../../lib/bash-policy.ts";
import { BashReviewComponent } from "./review.ts";

const ABORT_REMEMBER_MS = 60_000;

type BashPromptResult = {
  run: boolean;
  rejectReason?: string;
};

type RecentAbort = {
  at: number;
  rejectReason?: string;
};

async function promptForRejectReason(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const reason = await ctx.ui.input(
    "Why abort this command? (optional)",
    "Leave empty to continue without a reason",
  );
  const trimmed = reason?.trim();
  return trimmed || undefined;
}

async function promptForCommand(
  ctx: ExtensionContext,
  command: string,
  risk: BashRisk,
): Promise<BashPromptResult> {
  const reasons = risk.reasons.map((reason) => `• ${reason}`).join("\n");
  const message = `${reasons}\n\nCommand:\n${command}`;

  if (ctx.mode !== "tui") {
    const run = await ctx.ui.confirm(
      `${risk.severity.toUpperCase()} risk bash command`,
      message,
    );
    return run
      ? { run }
      : { run, rejectReason: await promptForRejectReason(ctx) };
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
  if (choice === "run") return { run: true };
  return { run: false, rejectReason: await promptForRejectReason(ctx) };
}

export default function bashGuard(pi: ExtensionAPI): void {
  pi.registerFlag("bash-guard-auto-allow", {
    description:
      "Allow flagged bash commands when interactive confirmation is unavailable",
    type: "boolean",
    default: false,
  });

  const recentlyAborted = new Map<string, RecentAbort>();
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;
    const risk = analyzeBashCommand(command);
    if (!risk) return;

    // Whitespace changes must not turn an aborted command into a new one.
    const abortKey = command.replace(/\s+/g, " ").trim();
    const previousAbort = recentlyAborted.get(abortKey);
    if (
      previousAbort !== undefined &&
      Date.now() - previousAbort.at < ABORT_REMEMBER_MS
    ) {
      const rejectReason = previousAbort.rejectReason
        ? ` The user's rejection reason was: ${previousAbort.rejectReason}.`
        : "";
      return {
        block: true,
        reason: `Blocked by bash-guard because the same command was aborted recently.${rejectReason} Do not retry it unchanged.`,
      };
    }

    if (!ctx.hasUI) {
      if (pi.getFlag("bash-guard-auto-allow") === true) return;
      return {
        block: true,
        reason: `Blocked by bash-guard because confirmation is unavailable: ${risk.reasons.join("; ")}.`,
      };
    }

    const result = await promptForCommand(ctx, command, risk);
    if (result.run) return;
    recentlyAborted.set(abortKey, {
      at: Date.now(),
      rejectReason: result.rejectReason,
    });
    const rejectReason = result.rejectReason
      ? ` The user's rejection reason was: ${result.rejectReason}.`
      : "";
    return {
      block: true,
      reason: `Blocked by the user through bash-guard.${rejectReason} Propose a safer command or ask before trying a materially different operation.`,
    };
  });
}
