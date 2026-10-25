import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askParent, {
  ASKED,
} from "../../../../extensions/subagents/tools/ask-parent.ts";

test("ask_parent ends the run with the question", async () => {
  let tool:
    | { execute: (...args: unknown[]) => Promise<Record<string, unknown>> }
    | undefined;
  askParent({
    registerTool: (definition: typeof tool) => {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  const result = await tool?.execute("call", { question: "Which port?" });
  assert.deepEqual(result, {
    content: [{ type: "text", text: ASKED }],
    details: { question: "Which port?" },
    terminate: true,
  });
});
