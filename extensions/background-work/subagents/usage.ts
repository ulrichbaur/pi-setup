import { readFileSync } from "node:fs";
import { isRecord } from "../../../lib/is-record.ts";
import type { UsageStats } from "./types.ts";

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
}

/** Adds the usage Pi reports for one assistant message. */
export function addUsage(target: UsageStats, value: unknown): void {
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

/**
 * The usage of the assistant messages in a session file, from the message
 * entry `start` on. Pi saves each assistant message with its usage.
 */
export function sessionUsage(path: string, start: number): UsageStats {
  const usage = emptyUsage();
  let index = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (index++ < start) continue;
    if (isRecord(message) && message.role === "assistant") {
      usage.turns += 1;
      addUsage(usage, message.usage);
    }
  }
  return usage;
}
