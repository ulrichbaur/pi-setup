import assert from "node:assert/strict";
import { test } from "node:test";
import { askQuestion } from "../../../../extensions/subagents/tools/ask-user.ts";

test("ask_user offers choices or free text and reports no answer", async () => {
  const calls: unknown[][] = [];
  const ui = {
    select: async (...args: unknown[]) => {
      calls.push(["select", ...args]);
      return "Postgres";
    },
    input: async (...args: unknown[]) => {
      calls.push(["input", ...args]);
      return "  ";
    },
  };
  assert.equal(
    await askQuestion(ui, "Which database?", ["Postgres", "SQLite"], undefined),
    "Postgres",
  );
  assert.equal(
    await askQuestion(ui, "Any notes?", undefined, undefined),
    undefined,
  );
  assert.equal(
    await askQuestion(undefined, "Hello?", [], undefined),
    undefined,
  );
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["select", "input"],
  );
});
