import { readFile } from "node:fs/promises";
import {
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { analyzeBashCommand } from "../../lib/bash-policy.ts";
import { isRecord } from "../../lib/is-record.ts";
import { parseSessionFile } from "../../lib/session-file.ts";

/** What happened to a bash call, read from its tool result. */
export type GuardOutcome = "ran" | "rejected" | "repeat" | "blocked";

export type InferredDecision = {
  callId: string;
  command: string;
  outcome: GuardOutcome;
  rejectReason?: string;
  timestamp: string;
};

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("\n");
}

function outcomeOf(text: string): GuardOutcome {
  if (text.includes("Blocked by the user through bash-guard"))
    return "rejected";
  if (text.includes("aborted recently")) return "repeat";
  if (text.includes("Blocked by bash-guard")) return "blocked";
  return "ran";
}

/** Pairs each bash call in a session with the result Pi recorded for it. */
export function inferDecisions(
  entries: readonly unknown[],
): InferredDecision[] {
  const calls = new Map<string, string>();
  const decisions: InferredDecision[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.message)) continue;
    const { message } = entry;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          isRecord(block) &&
          block.type === "toolCall" &&
          block.name === "bash" &&
          typeof block.id === "string" &&
          isRecord(block.arguments) &&
          typeof block.arguments.command === "string"
        ) {
          calls.set(block.id, block.arguments.command);
        }
      }
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string")
      continue;
    const command = calls.get(message.toolCallId);
    if (command === undefined) continue;
    const text = resultText(message.content);
    decisions.push({
      callId: message.toolCallId,
      command,
      outcome: outcomeOf(text),
      rejectReason: /rejection reason was: (.*?)\.(\s|$)/.exec(text)?.[1],
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    });
  }
  return decisions;
}

type Tally = Record<GuardOutcome, number>;

const emptyTally = (): Tally => ({
  ran: 0,
  rejected: 0,
  repeat: 0,
  blocked: 0,
});

function tallyText({ ran, rejected, repeat, blocked }: Tally): string {
  const parts = [`${ran} ran`, `${rejected} rejected`];
  if (repeat) parts.push(`${repeat} repeats blocked`);
  if (blocked) parts.push(`${blocked} blocked without asking`);
  return parts.join(", ");
}

/**
 * Classifies each decision with the current policy. Forked sessions copy
 * their history, so a call counts once by id.
 */
export function formatReport(
  decisions: readonly InferredDecision[],
  sessionCount: number,
  errors: readonly string[],
): string {
  const unique = new Map(
    decisions.map((decision) => [decision.callId, decision]),
  );
  const simple = emptyTally();
  const complex = emptyTally();
  const byReason = new Map<string, Tally>();
  const unflagged = emptyTally();
  const reasons: string[] = [];
  const days: string[] = [];

  for (const decision of unique.values()) {
    const risk = analyzeBashCommand(decision.command);
    if (!risk && decision.outcome === "ran") continue;
    if (decision.timestamp) days.push(decision.timestamp.slice(0, 10));
    if (!risk) {
      unflagged[decision.outcome] += 1;
    } else {
      (risk.complex ? complex : simple)[decision.outcome] += 1;
      if (!risk.complex) {
        for (const reason of new Set(risk.findings.map((f) => f.reason))) {
          const tally = byReason.get(reason) ?? emptyTally();
          tally[decision.outcome] += 1;
          byReason.set(reason, tally);
        }
      }
    }
    if (decision.rejectReason) {
      const command = decision.command.replace(/\s+/g, " ").slice(0, 60);
      reasons.push(`  "${decision.rejectReason}" for ${command}`);
    }
  }

  days.sort();
  const range = days.length ? ` from ${days[0]} to ${days.at(-1)}` : "";
  const lines = [
    `bash-guard decisions in ${sessionCount} sessions${range}, read from tool results:`,
    `Commands the current policy asks about: ${tallyText(simple)}`,
    `Complex commands it now blocks: ${tallyText(complex)}`,
    `Commands it no longer flags: ${tallyText(unflagged)}`,
  ];
  if (byReason.size) {
    lines.push("By reason:");
    const sorted = [...byReason].sort(
      ([, a], [, b]) => b.ran + b.rejected - (a.ran + a.rejected),
    );
    for (const [reason, tally] of sorted) {
      lines.push(`  ${reason}: ${tallyText(tally)}`);
    }
  }
  if (reasons.length) lines.push("Your rejection reasons:", ...reasons);
  lines.push(
    '"Ran" also counts sessions without bash-guard and commands an older policy did not flag.',
  );
  if (errors.length) {
    lines.push(`Sessions that could not be read (${errors.length}):`);
    lines.push(...errors.map((error) => `  ${error}`));
  }
  return lines.join("\n");
}

const USAGE = "Usage: /bash-guard stats";

export function registerBashGuardCommand(pi: ExtensionAPI): void {
  pi.registerCommand("bash-guard", {
    description:
      "`stats` shows how often flagged bash commands ran or were rejected",
    getArgumentCompletions: (prefix) =>
      "stats".startsWith(prefix)
        ? [
            {
              value: "stats",
              label: "stats",
              description: "Ran and rejected counts, by reason",
            },
          ]
        : null,
    handler: async (args, ctx) => {
      if (args.trim() !== "stats") {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      const sessions = await SessionManager.listAll();
      const decisions: InferredDecision[] = [];
      const errors: string[] = [];
      for (const session of sessions) {
        try {
          const { entries } = parseSessionFile(
            await readFile(session.path, "utf8"),
          );
          decisions.push(...inferDecisions(entries));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push(`${session.path}: ${message}`);
        }
      }
      ctx.ui.notify(formatReport(decisions, sessions.length, errors), "info");
    },
  });
}
