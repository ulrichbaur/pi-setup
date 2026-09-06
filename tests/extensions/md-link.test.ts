import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import markdownLinkExtension, {
  finalAssistantMarkdown,
  linkedMarkdownPath,
  markdownChangeMessage,
} from "../../extensions/md-link.ts";
import { withTempDir } from "../helpers.ts";

function assistantMessage(
  content: AssistantMessage["content"],
): AssistantMessage {
  return { role: "assistant", content } as AssistantMessage;
}

test("linkedMarkdownPath resolves relative and absolute paths", () => {
  assert.equal(
    linkedMarkdownPath("/tmp/project", "notes/session.md"),
    join("/tmp/project", "notes/session.md"),
  );
  assert.equal(
    linkedMarkdownPath("/tmp/project", "/tmp/session.md"),
    "/tmp/session.md",
  );
  assert.throws(() => linkedMarkdownPath("/tmp/project", "  "), /Usage/);
});

test("markdownChangeMessage sends only appended content", () => {
  assert.equal(
    markdownChangeMessage("Existing text\n", "Existing text\n\nNew request\n"),
    "New request",
  );
  assert.equal(markdownChangeMessage("Same", "Same"), null);
});

test("markdownChangeMessage describes inline replacements", () => {
  assert.equal(
    markdownChangeMessage(
      "# Plan\n\nUse SQLite.\n\nDone.",
      "# Plan\n\nUse Postgres.\n\nDone.",
    ),
    "Removed:\nUse SQLite.\n\nReplaced with:\nUse Postgres.",
  );
});

test("finalAssistantMarkdown excludes tool-calling messages", () => {
  assert.equal(
    finalAssistantMarkdown(
      assistantMessage([
        { type: "text", text: "Checking" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ]),
    ),
    null,
  );
  assert.equal(
    finalAssistantMarkdown(
      assistantMessage([
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "Final answer" },
      ]),
    ),
    "Final answer",
  );
});

test("linked workflow appends assistant replies and sends later edits", () =>
  withTempDir("md-link-test-", async (directory) => {
    type CommandHandler = (
      args: string,
      ctx: ExtensionCommandContext,
    ) => Promise<void>;
    type SessionStartHandler = (
      event: SessionStartEvent,
      ctx: ExtensionContext,
    ) => Promise<void>;
    type MessageEndHandler = (event: {
      type: "message_end";
      message: AssistantMessage;
    }) => Promise<void>;

    const commands = new Map<string, CommandHandler>();
    let sessionStart: SessionStartHandler | undefined;
    let messageEnd: MessageEndHandler | undefined;
    const entries: Array<{ customType: string; data: unknown }> = [];
    const sentMessages: string[] = [];
    const notifications: string[] = [];

    const pi = {
      registerCommand(
        name: string,
        definition: { handler: CommandHandler },
      ): void {
        commands.set(name, definition.handler);
      },
      on(
        event: string,
        handler: SessionStartHandler | MessageEndHandler,
      ): void {
        if (event === "session_start") {
          sessionStart = handler as SessionStartHandler;
        } else if (event === "message_end") {
          messageEnd = handler as MessageEndHandler;
        }
      },
      appendEntry(customType: string, data: unknown): void {
        entries.push({ customType, data });
      },
      sendUserMessage(message: string): void {
        sentMessages.push(message);
      },
    } as unknown as ExtensionAPI;

    markdownLinkExtension(pi);
    assert.ok(commands.has("link-md"));
    assert.ok(commands.has("unlink-md"));
    assert.ok(commands.has("send-diff"));
    assert.ok(commands.has("sd"));
    assert.ok(sessionStart);
    assert.ok(messageEnd);

    const context = {
      cwd: directory,
      waitForIdle: async () => {},
      isIdle: () => true,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setStatus() {},
      },
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionCommandContext;

    const target = join(directory, "notes.md");
    await writeFile(target, "Existing notes\n", "utf8");
    await commands.get("link-md")?.("notes.md", context);
    assert.deepEqual(entries.at(-1), {
      customType: "md-link",
      data: { file: target },
    });
    assert.equal(sentMessages.length, 0);

    await messageEnd({
      type: "message_end",
      message: assistantMessage([{ type: "text", text: "Assistant reply" }]),
    });
    assert.equal(
      await readFile(target, "utf8"),
      "Existing notes\n\nAssistant reply\n\n---\n---\n",
    );

    await appendFile(target, "\nPlease revise the introduction.\n", "utf8");
    await commands.get("sd")?.("", context);
    assert.deepEqual(sentMessages, ["Please revise the introduction."]);
    assert.equal(
      notifications.some((message) => message.includes("Linked")),
      true,
    );
  }));
