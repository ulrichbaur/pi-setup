import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BashFinding } from "../../lib/bash-policy.ts";
import { isRecord } from "../../lib/is-record.ts";

export const DECISIONS_PATH = join(
  getAgentDir(),
  "bash-guard",
  "decisions.jsonl",
);

/** What happened to a flagged bash call. */
export type GuardOutcome = "ran" | "rejected" | "repeat" | "blocked";

const OUTCOMES = new Set<string>(["ran", "rejected", "repeat", "blocked"]);

export type DecisionRecord = {
  time: string;
  outcome: GuardOutcome;
  findings: BashFinding[];
  rejectReason?: string;
};

export function recordDecision(record: DecisionRecord, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function isFinding(value: unknown): value is BashFinding {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    typeof value.reason === "string"
  );
}

function isDecision(value: unknown): value is DecisionRecord {
  return (
    isRecord(value) &&
    typeof value.time === "string" &&
    typeof value.outcome === "string" &&
    OUTCOMES.has(value.outcome) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    (value.rejectReason === undefined || typeof value.rejectReason === "string")
  );
}

/**
 * Undefined when the log does not exist yet. A line that cannot be read is
 * counted rather than fatal, because the log is a record, not configuration.
 */
export function readDecisions(
  path: string,
): { records: DecisionRecord[]; unreadable: number } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const records: DecisionRecord[] = [];
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isDecision(value)) records.push(value);
      else unreadable += 1;
    } catch {
      unreadable += 1;
    }
  }
  return { records, unreadable };
}
