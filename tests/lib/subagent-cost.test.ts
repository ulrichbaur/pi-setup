import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCost, isSubagentCostEvent } from "../../lib/subagent-cost.ts";

test("cost events carry one finite, non-negative cost", () => {
  assert.equal(isSubagentCostEvent({ cost: 0.5 }), true);
  assert.equal(isSubagentCostEvent({ cost: 0 }), true);
  assert.equal(isSubagentCostEvent({ cost: -1 }), false);
  assert.equal(isSubagentCostEvent({ cost: Number.NaN }), false);
  assert.equal(isSubagentCostEvent({ cost: "1" }), false);
  assert.equal(isSubagentCostEvent(undefined), false);
});

test("costs below one cent keep four decimals", () => {
  assert.equal(formatCost(0.0045), "$0.0045");
  assert.equal(formatCost(1.2345), "$1.234");
});
