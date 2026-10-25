import { isRecord } from "./is-record.ts";

export const SUBAGENT_COST_CHANNEL = "subagents:cost";

/**
 * The total cost of the subagent runs on the session's current branch,
 * including the cost so far of running ones, as Pi reports cost.
 */
export interface SubagentCostEvent {
  cost: number;
}

export function isSubagentCostEvent(
  value: unknown,
): value is SubagentCostEvent {
  return (
    isRecord(value) &&
    typeof value.cost === "number" &&
    Number.isFinite(value.cost) &&
    value.cost >= 0
  );
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(cost < 0.01 ? 4 : 3)}`;
}
