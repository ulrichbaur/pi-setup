import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { analyzeBashCommand } from "../../lib/bash-policy.ts";
import { isRecord } from "../../lib/is-record.ts";
import { parseSessionFile } from "../../lib/session-file.ts";
import {
  type DecisionRecord,
  type GuardOutcome,
  readDecisions,
} from "./decisions.ts";

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

/** `ranWord` is "approved" where a run is known to be the user's choice. */
function tallyText(
  { ran, rejected, repeat, blocked }: Tally,
  ranWord = "ran",
): string {
  const parts = [`${ran} ${ranWord}`, `${rejected} rejected`];
  if (repeat) parts.push(`${repeat} repeats blocked`);
  if (blocked) parts.push(`${blocked} blocked without asking`);
  return parts.join(", ");
}

function countReasons(
  byReason: Map<string, Tally>,
  reasons: Iterable<string>,
  outcome: GuardOutcome,
): void {
  for (const reason of new Set(reasons)) {
    const tally = byReason.get(reason) ?? emptyTally();
    tally[outcome] += 1;
    byReason.set(reason, tally);
  }
}

function reasonLines(byReason: Map<string, Tally>, ranWord = "ran"): string[] {
  if (byReason.size === 0) return [];
  const sorted = [...byReason].sort(
    ([, a], [, b]) => b.ran + b.rejected - (a.ran + a.rejected),
  );
  return [
    "By reason:",
    ...sorted.map(
      ([reason, tally]) => `  ${reason}: ${tallyText(tally, ranWord)}`,
    ),
  ];
}

function dayRange(days: string[]): string {
  days.sort();
  return days.length ? ` from ${days[0]} to ${days.at(-1)}` : "";
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
        countReasons(
          byReason,
          risk.findings.map((finding) => finding.reason),
          decision.outcome,
        );
      }
    }
    if (decision.rejectReason) {
      const command = decision.command.replace(/\s+/g, " ").slice(0, 60);
      reasons.push(`  "${decision.rejectReason}" for ${command}`);
    }
  }

  const lines = [
    `bash-guard decisions in ${sessionCount} sessions${dayRange(days)}, read from tool results:`,
    `Commands the current policy asks about: ${tallyText(simple)}`,
    `Complex commands it now blocks: ${tallyText(complex)}`,
    `Commands it no longer flags: ${tallyText(unflagged)}`,
  ];
  lines.push(...reasonLines(byReason));
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

/** The exact decisions bash-guard recorded, from one or more logs. */
export function formatRecorded(
  records: readonly DecisionRecord[],
  sources: readonly string[],
): string {
  if (records.length === 0) {
    return `No decisions recorded yet in ${sources.join(", ")}.`;
  }
  const total = emptyTally();
  const byReason = new Map<string, Tally>();
  const reasons: string[] = [];
  for (const record of records) {
    total[record.outcome] += 1;
    countReasons(
      byReason,
      record.findings.map((finding) => finding.reason),
      record.outcome,
    );
    if (record.rejectReason) {
      const steps = record.findings.map((finding) => finding.command);
      reasons.push(`  "${record.rejectReason}" for ${steps.join("; ")}`);
    }
  }
  const days = records.map((record) => record.time.slice(0, 10));
  return [
    `Recorded decisions${dayRange(days)} in ${sources.join(", ")}:`,
    `All flagged commands: ${tallyText(total, "approved")}`,
    ...reasonLines(byReason, "approved"),
    ...(reasons.length ? ["Your rejection reasons:", ...reasons] : []),
  ].join("\n");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/")
    ? `${homedir()}${path.slice(1)}`
    : path;
}

/** Reads the local log and any logs given as arguments, such as a copy from another machine. */
function recordedSection(
  paths: string[],
  decisionsPath: string,
  cwd: string,
): string {
  const extra = paths.map((path) => resolve(cwd, expandHome(path)));
  const records: DecisionRecord[] = [];
  const problems: string[] = [];
  for (const path of [decisionsPath, ...extra]) {
    try {
      const log = readDecisions(path);
      if (!log) {
        if (path !== decisionsPath) problems.push(`${path}: file not found`);
        continue;
      }
      records.push(...log.records);
      if (log.unreadable) {
        problems.push(`${path}: ${log.unreadable} lines could not be read`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${path}: ${message}`);
    }
  }
  return [formatRecorded(records, [decisionsPath, ...extra]), ...problems].join(
    "\n",
  );
}

const USAGE = "Usage: /bash-guard stats [decision logs from other machines]";

export function registerBashGuardCommand(
  pi: ExtensionAPI,
  decisionsPath: string,
): void {
  pi.registerCommand("bash-guard", {
    description:
      "`stats` shows how often flagged bash commands were approved or rejected",
    getArgumentCompletions: (prefix) =>
      "stats ".startsWith(prefix)
        ? [
            {
              value: "stats ",
              label: "stats",
              description: "Approvals and rejections, by reason",
            },
          ]
        : null,
    handler: async (args, ctx) => {
      const [action, ...paths] = args.trim().split(/\s+/).filter(Boolean);
      if (action !== "stats") {
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
      ctx.ui.notify(
        `${recordedSection(paths, decisionsPath, ctx.cwd)}\n\n${formatReport(decisions, sessions.length, errors)}`,
        "info",
      );
    },
  });
}
