import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import saveMarkdown, {
  assistantMarkdown,
  latestAssistantMarkdown,
  markdownTarget,
} from "../extensions/save-md.ts";

const assistant = (content: unknown): SessionEntry =>
  ({
    type: "message",
    id: "assistant",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content },
  }) as unknown as SessionEntry;

test("assistantMarkdown extracts Markdown text blocks", () => {
  assert.equal(
    assistantMarkdown(
      assistant([
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "# Heading" },
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        { type: "text", text: "Answer" },
      ]),
    ),
    "# Heading\n\nAnswer",
  );
});

test("latestAssistantMarkdown uses the newest textual assistant message", () => {
  assert.equal(
    latestAssistantMarkdown([
      assistant([{ type: "text", text: "Older" }]),
      {
        type: "message",
        id: "user",
        parentId: "assistant",
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: "Prompt" },
      } as unknown as SessionEntry,
      assistant([
        { type: "toolCall", id: "call-2", name: "read", arguments: {} },
      ]),
      assistant([{ type: "text", text: "Newest" }]),
    ]),
    "Newest",
  );
});

test("markdownTarget adds the suffix and supports subdirectories", () => {
  assert.equal(
    markdownTarget("/tmp/project", "notes/answer"),
    join("/tmp/project", "notes/answer.md"),
  );
  assert.equal(
    markdownTarget("/tmp/project", "notes/already.md"),
    join("/tmp/project", "notes/already.md"),
  );
});

test("markdownTarget rejects empty names and supports absolute paths", () => {
  assert.throws(() => markdownTarget("/tmp/project", ""), /Usage/);
  assert.equal(markdownTarget("/tmp/project", "/tmp/answer"), "/tmp/answer.md");
  assert.equal(markdownTarget("/tmp/project", "../answer"), "/tmp/answer.md");
});

test("/save-md writes Markdown and refuses to overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "save-md-test-"));
  const notifications: string[] = [];
  let command:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;

  try {
    const registerCommand = (
      _name: string,
      definition: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      command = definition.handler;
    };
    saveMarkdown({ registerCommand } as unknown as ExtensionAPI);

    const context = {
      cwd: directory,
      waitForIdle: async () => {},
      sessionManager: {
        getBranch: () => [assistant([{ type: "text", text: "# Answer" }])],
      },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as unknown as ExtensionCommandContext;

    await command?.("notes/answer", context);
    assert.equal(
      await readFile(join(directory, "notes/answer.md"), "utf8"),
      "# Answer\n",
    );

    await command?.("notes/answer", context);
    assert.match(
      notifications.at(-1) ?? "",
      /^Could not save Markdown: EEXIST: file already exists/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
