import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyTranscriptEvent,
  countMessageEntries,
  emptyTranscript,
  loadTranscript,
} from "../../../extensions/subagents/transcript.ts";
import { withTempDir } from "../../helpers.ts";

test("deltas build the streaming message until message_end replaces it", () => {
  const transcript = emptyTranscript();
  const apply = (event: Record<string, unknown>) =>
    applyTranscriptEvent(transcript, event);
  const update = (assistantMessageEvent: Record<string, unknown>) =>
    apply({ type: "message_update", assistantMessageEvent });

  apply({ type: "message_end", message: { role: "system", content: "" } });
  apply({ type: "message_end", message: { role: "user", content: "Task" } });
  apply({ type: "message_start", message: { role: "assistant", content: [] } });
  update({ type: "thinking_start", contentIndex: 0 });
  update({ type: "thinking_delta", contentIndex: 0, delta: "Plan" });
  update({ type: "text_start", contentIndex: 1 });
  update({ type: "text_delta", contentIndex: 1, delta: "Hel" });
  update({ type: "text_delta", contentIndex: 1, delta: "lo" });
  update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "ls" });
  assert.deepEqual(transcript.streaming?.content, [
    { type: "thinking", thinking: "Plan" },
    { type: "text", text: "Hello" },
    { type: "toolCall", id: "c1", name: "ls", arguments: {} },
  ]);
  update({ type: "text_end", contentIndex: 1, content: "Hello!" });
  update({
    type: "toolcall_end",
    contentIndex: 2,
    toolCall: {
      type: "toolCall",
      id: "c1",
      name: "ls",
      arguments: { path: "." },
    },
  });
  assert.deepEqual(transcript.streaming?.content, [
    { type: "thinking", thinking: "Plan" },
    { type: "text", text: "Hello!" },
    { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
  ]);

  const final = { role: "assistant", content: [{ type: "text", text: "Hi" }] };
  apply({ type: "message_end", message: final });
  assert.equal(transcript.streaming, undefined);
  assert.deepEqual(
    transcript.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(transcript.messages[1], final);
});

test("tool results stay pending until their message arrives", () => {
  const transcript = emptyTranscript();
  applyTranscriptEvent(transcript, {
    type: "tool_execution_update",
    toolCallId: "c1",
    partialResult: { content: [{ type: "text", text: "half" }] },
  });
  assert.deepEqual(transcript.pendingResults.c1, {
    content: [{ type: "text", text: "half" }],
    details: undefined,
    isError: false,
    partial: true,
  });
  applyTranscriptEvent(transcript, {
    type: "tool_execution_end",
    toolCallId: "c1",
    result: { content: [], details: { code: 1 } },
    isError: true,
  });
  assert.equal(transcript.pendingResults.c1.partial, false);
  assert.equal(transcript.pendingResults.c1.isError, true);
  applyTranscriptEvent(transcript, {
    type: "message_end",
    message: { role: "toolResult", toolCallId: "c1", content: [] },
  });
  assert.deepEqual(transcript.pendingResults, {});
  assert.equal(transcript.messages.length, 1);
});

test("a run's messages load from its range of the session file", async () => {
  await withTempDir("subagent-transcript-", (directory) => {
    const path = join(directory, "session.jsonl");
    const line = (value: unknown) => `${JSON.stringify(value)}\n`;
    const message = (role: string, text: string) =>
      line({ type: "message", message: { role, content: text } });
    writeFileSync(
      path,
      line({ type: "session", cwd: "/repo" }) +
        message("system", "prompt") +
        message("user", "first") +
        "not json\n" +
        message("assistant", "one"),
    );
    assert.equal(countMessageEntries(path), 3);
    assert.equal(countMessageEntries(join(directory, "missing.jsonl")), 0);
    assert.equal(countMessageEntries(undefined), 0);

    appendFileSync(
      path,
      message("user", "second") + message("assistant", "two"),
    );
    assert.deepEqual(
      loadTranscript(path, 3, 5).map((entry) => entry.content),
      ["second", "two"],
    );
    assert.deepEqual(
      loadTranscript(path, 0, 3).map((entry) => entry.content),
      ["first", "one"],
    );
    assert.throws(() => loadTranscript(join(directory, "gone.jsonl"), 0, 1), {
      message: `${join(directory, "gone.jsonl")}: session file no longer exists`,
    });
  });
});
