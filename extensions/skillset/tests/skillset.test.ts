import assert from "node:assert/strict";
import { test } from "node:test";
import skillset from "../index.ts";

test("the combined extension registers palette and policy features", () => {
  const commands: string[] = [];
  const events: string[] = [];
  const renderers: string[] = [];

  skillset({
    registerCommand(name: string) {
      commands.push(name);
    },
    registerMessageRenderer(customType: string) {
      renderers.push(customType);
    },
    on(name: string) {
      events.push(name);
    },
  } as any);

  assert.deepEqual(commands, ["skill", "skill-policy"]);
  assert.deepEqual(renderers, ["skill-palette"]);
  assert.deepEqual(events, ["before_agent_start", "before_agent_start"]);
});
