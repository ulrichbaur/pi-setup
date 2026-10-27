import { readFileSync, statSync } from "node:fs";
import { isRecord } from "../../lib/is-record.ts";
import type { RpcRecord } from "./rpc.ts";

export type TranscriptMessage = Record<string, unknown> & { role: string };

/** A tool result that has not reached the transcript as a message yet. */
export interface PendingToolResult {
  content: unknown[];
  details?: unknown;
  isError: boolean;
  partial: boolean;
}

export interface LiveTranscript {
  messages: TranscriptMessage[];
  streaming?: TranscriptMessage;
  pendingResults: Record<string, PendingToolResult>;
}

export function emptyTranscript(): LiveTranscript {
  return { messages: [], pendingResults: {} };
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

// Pi records the system prompt as a message; the transcript leaves it out.
function isShown(message: unknown): message is TranscriptMessage {
  return (
    isRecord(message) &&
    typeof message.role === "string" &&
    message.role !== "system"
  );
}

function contentBlock(
  message: TranscriptMessage,
  index: unknown,
): Record<string, unknown> | undefined {
  if (typeof index !== "number" || !Array.isArray(message.content)) {
    return undefined;
  }
  const block = message.content[index];
  return isRecord(block) ? block : undefined;
}

function applyDelta(message: TranscriptMessage, update: RpcRecord): void {
  if (!Array.isArray(message.content)) message.content = [];
  const content = message.content as unknown[];
  const index = update.contentIndex;
  switch (update.type) {
    case "text_start":
      if (typeof index === "number")
        content[index] = { type: "text", text: "" };
      return;
    case "thinking_start":
      if (typeof index === "number") {
        content[index] = { type: "thinking", thinking: "" };
      }
      return;
    case "toolcall_start":
      if (typeof index === "number") {
        content[index] = {
          type: "toolCall",
          id: update.id,
          name: update.toolName,
          arguments: {},
        };
      }
      return;
    case "text_delta":
    case "thinking_delta": {
      const block = contentBlock(message, index);
      const key = update.type === "text_delta" ? "text" : "thinking";
      if (block && typeof update.delta === "string") {
        block[key] =
          `${typeof block[key] === "string" ? block[key] : ""}${update.delta}`;
      }
      return;
    }
    case "text_end":
    case "thinking_end": {
      const block = contentBlock(message, index);
      const key = update.type === "text_end" ? "text" : "thinking";
      if (block && typeof update.content === "string") {
        block[key] = update.content;
      }
      return;
    }
    case "toolcall_end":
      if (typeof index === "number" && isRecord(update.toolCall)) {
        content[index] = update.toolCall;
      }
      return;
  }
}

function pendingResult(value: unknown, partial: boolean, isError = false) {
  const result = isRecord(value) ? value : {};
  return {
    content: Array.isArray(result.content) ? result.content : [],
    details: result.details,
    isError,
    partial,
  };
}

export function applyTranscriptEvent(
  transcript: LiveTranscript,
  event: RpcRecord,
): void {
  switch (event.type) {
    case "message_start":
      if (isShown(event.message) && event.message.role === "assistant") {
        transcript.streaming = { ...event.message, content: [] };
      }
      return;
    case "message_update":
      if (transcript.streaming && isRecord(event.assistantMessageEvent)) {
        applyDelta(transcript.streaming, event.assistantMessageEvent);
      }
      return;
    case "message_end":
      if (!isShown(event.message)) return;
      if (event.message.role === "assistant") transcript.streaming = undefined;
      if (
        event.message.role === "toolResult" &&
        typeof event.message.toolCallId === "string"
      ) {
        delete transcript.pendingResults[event.message.toolCallId];
      }
      transcript.messages.push(event.message);
      return;
    case "tool_execution_update":
      if (typeof event.toolCallId === "string") {
        transcript.pendingResults[event.toolCallId] = pendingResult(
          event.partialResult,
          true,
        );
      }
      return;
    case "tool_execution_end":
      if (typeof event.toolCallId === "string") {
        transcript.pendingResults[event.toolCallId] = pendingResult(
          event.result,
          false,
          event.isError === true,
        );
      }
      return;
  }
}

export function countMessageEntries(path: string | undefined): number {
  if (!path) return 0;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  return parseMessageEntries(text).length;
}

function parseMessageEntries(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(entry) && entry.type === "message") {
      messages.push(entry.message);
    }
  }
  return messages;
}

const fileCache = new Map<
  string,
  { mtimeMs: number; size: number; messages: unknown[] }
>();

/**
 * `start` and `end` count message entries,
 * including ones the transcript hides.
 */
export function loadTranscript(
  path: string,
  start: number,
  end: number,
): TranscriptMessage[] {
  let stats: { mtimeMs: number; size: number };
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`${path}: session file no longer exists`);
  }
  let cached = fileCache.get(path);
  if (
    !cached ||
    cached.mtimeMs !== stats.mtimeMs ||
    cached.size !== stats.size
  ) {
    cached = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      messages: parseMessageEntries(readFileSync(path, "utf8")),
    };
    fileCache.set(path, cached);
  }
  return cached.messages.slice(start, end).filter(isShown);
}
