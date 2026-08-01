import assert from "node:assert/strict";
import { test } from "node:test";
import skillset, { registerSkillsetFeatures } from "../index.ts";

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

  assert.deepEqual(commands, ["skill", "skill-policy", "usage"]);
  assert.deepEqual(renderers, []);
  // Palette prewarm and policy filtering both hook the agent start.
  assert.deepEqual(events, ["before_agent_start", "before_agent_start"]);
});

test("a visible feature failure does not prevent later registration", () => {
  const registered: string[] = [];
  const diagnostics: string[] = [];

  const errors = registerSkillsetFeatures(
    {} as any,
    [
      {
        name: "broken",
        register() {
          throw new Error("boom");
        },
      },
      {
        name: "healthy",
        register() {
          registered.push("healthy");
        },
      },
    ],
    (message) => diagnostics.push(message),
  );

  assert.deepEqual(registered, ["healthy"]);
  assert.deepEqual(errors, ["Skillset broken registration failed: boom"]);
  assert.deepEqual(diagnostics, errors);
});

test("registration failures are shown when the session starts", async () => {
  type Handler = (event: unknown, ctx: any) => unknown;
  const commands: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const diagnostics: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message: string) => diagnostics.push(message);

  try {
    skillset({
      registerCommand(name: string) {
        if (name === "skill") throw new Error("palette unavailable");
        commands.push(name);
      },
      registerMessageRenderer() {},
      on(name: string, handler: Handler) {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      },
    } as any);
  } finally {
    console.error = originalConsoleError;
  }

  const notifications: Array<{ message: string; level: string }> = [];
  for (const handler of handlers.get("session_start") ?? []) {
    await handler(
      {},
      {
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      },
    );
  }

  assert.deepEqual(commands, ["skill-policy", "usage"]);
  assert.deepEqual(diagnostics, [
    "Skillset palette registration failed: palette unavailable",
  ]);
  assert.deepEqual(notifications, [
    {
      message: "Skillset palette registration failed: palette unavailable",
      level: "error",
    },
  ]);
});
