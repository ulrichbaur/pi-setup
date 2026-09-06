import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import contextExtension, {
  type ContextBreakdown,
  computeContextBreakdown,
  renderContextOverlay,
} from "../../extensions/context.ts";

function entry(type: SessionEntry["type"], value: object): SessionEntry {
  return {
    type,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    ...value,
  } as SessionEntry;
}

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Consider the request" },
      { type: "text", text: "Here is the answer" },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    ],
    usage: {
      input: 100,
      output: 50,
      cacheRead: 40,
      cacheWrite: 20,
      totalTokens: 150,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0001,
        cacheWrite: 0.0002,
        total: 0.0033,
      },
    },
  } as AssistantMessage;
}

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
  bg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
  italic(text: string) {
    return text;
  },
  strikethrough(text: string) {
    return text;
  },
} as unknown as Theme;

test("computeContextBreakdown categorizes active context and session stats", () => {
  const assistant = entry("message", { message: assistantMessage() });
  const contextEntries: SessionEntry[] = [
    entry("message", {
      message: { role: "user", content: "Explain this code", timestamp: 0 },
    }),
    assistant,
    entry("message", {
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "const value = 1;" }],
        isError: false,
        timestamp: 0,
      },
    }),
    entry("compaction", {
      summary: "Earlier work was compacted",
      firstKeptEntryId: "message-id",
      tokensBefore: 500,
    }),
    entry("custom_message", {
      customType: "test",
      content: "Injected context",
      display: false,
    }),
  ];
  const context = {
    getContextUsage: () => ({
      tokens: 8_500,
      contextWindow: 10_000,
      percent: 85,
    }),
    getSystemPrompt: () => "System instructions",
    sessionManager: {
      buildContextEntries: () => contextEntries,
      getBranch: () => contextEntries,
    },
  } as unknown as ExtensionCommandContext;

  const breakdown = computeContextBreakdown(context);
  assert.ok(breakdown);
  assert.equal(breakdown.totalTokens, 8_500);
  assert.equal(breakdown.contextWindow, 10_000);
  assert.equal(breakdown.turnCount, 1);
  assert.equal(breakdown.messageCount, 3);
  assert.equal(breakdown.cacheRead, 40);
  assert.equal(breakdown.cacheWrite, 20);
  assert.equal(breakdown.totalCost, 0.0033);
  assert.equal(
    breakdown.categories.reduce(
      (total, category) => total + category.tokens,
      0,
    ),
    10_000,
  );
  assert.equal(
    breakdown.categories.find((category) => category.key === "free")?.tokens,
    1_500,
  );
  for (const key of [
    "system",
    "user",
    "assistant",
    "thinking",
    "tool:read",
    "compaction",
    "custom",
  ]) {
    assert.ok(
      breakdown.categories.some((category) => category.key === key),
      `missing category ${key}`,
    );
  }
});

test("renderContextOverlay keeps every line within the available width", () => {
  const breakdown: ContextBreakdown = {
    categories: [
      {
        key: "system",
        label: "System prompt",
        tokens: 2_000,
        color: "mdHeading",
      },
      {
        key: "tool:read",
        label: "Tool: read",
        tokens: 6_500,
        color: "syntaxFunction",
      },
      { key: "free", label: "Free", tokens: 1_500, color: "dim" },
    ],
    totalTokens: 8_500,
    contextWindow: 10_000,
    percent: 85,
    cacheRead: 4_000,
    cacheWrite: 500,
    totalCost: 0.1234,
    messageCount: 12,
    turnCount: 6,
  };

  const lines = renderContextOverlay(breakdown, theme, 60);
  assert.ok(lines.length > 10);
  assert.match(lines.join("\n"), /Context Window Usage \(85\.0%\)/);
  assert.match(lines.join("\n"), /Consider \/compact/);
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 60),
    true,
  );
});

test("/context reports that non-TUI modes cannot show the overlay", async () => {
  let command:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  contextExtension({
    registerCommand(
      name: string,
      definition: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      assert.equal(name, "context");
      command = definition.handler;
    },
  } as unknown as ExtensionAPI);
  assert.ok(command);

  const notifications: string[] = [];
  await command("", {
    mode: "print",
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext);
  assert.deepEqual(notifications, ["The context overlay requires TUI mode"]);
});
