import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TranscriptMessage } from "../../../extensions/subagents/transcript.ts";
import {
  releaseTranscript,
  renderTranscript,
} from "../../../extensions/subagents/transcript-view.ts";

initTheme("dark");

// Strips colors, links, and prompt marks, trims lines, and drops empty ones.
const plain = (lines: string[]) =>
  lines
    .join("\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes.
    .replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\|\x1b\]133;[A-Z]\x07?/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

test("a transcript shows messages and each tool call with its result", () => {
  const messages: TranscriptMessage[] = [
    { role: "user", content: [{ type: "text", text: "Task: list files" }] },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Listing now." },
        { type: "toolCall", id: "c1", name: "ls", arguments: { path: "lib" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "ls",
      content: [{ type: "text", text: "a.ts\nb.ts" }],
      isError: false,
    },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "c2",
          name: "safe_bash",
          arguments: { command: "pnpm test" },
        },
      ],
    },
  ];
  const view = renderTranscript(messages, {
    cwd: "/repo",
    invalidate: () => {},
    pendingResults: {
      c2: {
        content: [{ type: "text", text: "running tests" }],
        isError: false,
        partial: true,
      },
    },
    streaming: {
      role: "assistant",
      content: [{ type: "text", text: "Streaming now" }],
    },
  });
  const lines = plain(view.render(80));
  try {
    assert.deepEqual(lines, [
      "Task: list files",
      "Listing now.",
      "ls lib",
      "a.ts",
      "b.ts",
      "$ pnpm test",
      "running tests",
      "Elapsed 0.0s",
      "Streaming now",
    ]);
  } finally {
    releaseTranscript(messages);
  }
  assert.ok(plain(view.render(80)).includes("Stopped"));
});

test("a tool call of an aborted message shows why it has no result", () => {
  const messages: TranscriptMessage[] = [
    {
      role: "assistant",
      stopReason: "aborted",
      content: [
        { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
      ],
    },
  ];
  const lines = plain(
    renderTranscript(messages, { cwd: "/repo", invalidate: () => {} }).render(
      80,
    ),
  );
  assert.ok(lines.includes("Operation aborted"), lines.join("\n"));
});

test("thinking blocks follow the setting, also on cached messages", () => {
  const messages: TranscriptMessage[] = [
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "Weighing the options" },
        { type: "text", text: "Use Postgres." },
      ],
    },
  ];
  const render = (hideThinking: boolean) =>
    plain(
      renderTranscript(messages, {
        cwd: "/repo",
        invalidate: () => {},
        hideThinking,
      }).render(80),
    ).join("\n");

  assert.match(render(false), /Weighing the options/);
  assert.doesNotMatch(render(true), /Weighing the options/);
  assert.match(render(true), /Use Postgres\./);
  assert.match(render(false), /Weighing the options/);
});
