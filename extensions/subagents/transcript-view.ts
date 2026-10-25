import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  type ToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, type TUI } from "@earendil-works/pi-tui";
import { isRecord } from "../../lib/is-record.ts";
import type { AgentResult } from "./index.ts";
import {
  loadTranscript,
  type PendingToolResult,
  type TranscriptMessage,
} from "./transcript.ts";

// biome-ignore lint/suspicious/noExplicitAny: definitions differ in their parameter types.
type AnyToolDefinition = ToolDefinition<any, any, any>;
const TOOL_RENDERERS: Record<string, (cwd: string) => AnyToolDefinition> = {
  read: createReadToolDefinition,
  write: createWriteToolDefinition,
  edit: createEditToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
  safe_bash: createBashToolDefinition,
};

export interface TranscriptDisplay {
  invalidate: () => void;
  hideThinking: boolean;
}

export interface TranscriptViewOptions {
  cwd: string;
  hideThinking?: boolean;
  streaming?: TranscriptMessage;
  pendingResults?: Record<string, PendingToolResult>;
  invalidate: () => void;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

// Completed messages never change, so their components are built once.
interface CachedMessage {
  component: Component;
  tools: Map<string, ToolExecutionComponent>;
  // Tool calls showing a partial result. Their rows redraw every second
  // until a final result arrives.
  running: Set<string>;
  redraw: { invalidate: () => void };
  hideThinking: boolean;
}
const cache = new WeakMap<TranscriptMessage, CachedMessage>();

function text(content: unknown): string {
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

function toolCalls(message: TranscriptMessage): ToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (block): block is ToolCall =>
      isRecord(block) &&
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string",
  );
}

function cachedMessage(
  message: TranscriptMessage,
  options: TranscriptViewOptions,
): CachedMessage {
  const hideThinking = options.hideThinking === true;
  let entry = cache.get(message);
  if (!entry) {
    const component =
      message.role === "assistant"
        ? new AssistantMessageComponent(
            message as never,
            hideThinking,
            getMarkdownTheme(),
          )
        : new UserMessageComponent(text(message.content), getMarkdownTheme());
    entry = {
      component,
      tools: new Map(),
      running: new Set(),
      redraw: { invalidate: options.invalidate },
      hideThinking,
    };
    cache.set(message, entry);
  }
  if (
    entry.hideThinking !== hideThinking &&
    entry.component instanceof AssistantMessageComponent
  ) {
    entry.component.setHideThinkingBlock(hideThinking);
    entry.hideThinking = hideThinking;
  }
  entry.redraw.invalidate = options.invalidate;
  return entry;
}

function toolComponent(
  entry: CachedMessage,
  call: ToolCall,
  cwd: string,
): ToolExecutionComponent {
  let component = entry.tools.get(call.id);
  if (!component) {
    const redraw = entry.redraw;
    // ToolExecutionComponent uses the TUI only to request redraws.
    const tui = { requestRender: () => redraw.invalidate() } as unknown as TUI;
    component = new ToolExecutionComponent(
      call.name,
      call.id,
      call.arguments,
      { showImages: false },
      TOOL_RENDERERS[call.name]?.(cwd),
      tui,
      cwd,
    );
    entry.tools.set(call.id, component);
  }
  return component;
}

function addToolCalls(
  container: Container,
  entry: CachedMessage,
  message: TranscriptMessage,
  results: Map<string, TranscriptMessage>,
  options: TranscriptViewOptions,
): void {
  const failed =
    message.stopReason === "aborted" || message.stopReason === "error";
  for (const call of toolCalls(message)) {
    const component = toolComponent(entry, call, options.cwd);
    component.updateArgs(call.arguments);
    const result = results.get(call.id);
    const pending = options.pendingResults?.[call.id];
    if (result) {
      component.updateResult(result as never);
      entry.running.delete(call.id);
    } else if (pending) {
      component.markExecutionStarted();
      component.updateResult(pending as never, pending.partial);
      if (pending.partial) entry.running.add(call.id);
      else entry.running.delete(call.id);
    } else if (failed) {
      const reason =
        message.stopReason === "aborted"
          ? "Operation aborted"
          : typeof message.errorMessage === "string"
            ? message.errorMessage
            : "Error";
      component.updateResult({
        content: [{ type: "text", text: reason }],
        isError: true,
      });
    }
    container.addChild(component);
  }
}

export function renderTranscript(
  messages: TranscriptMessage[],
  options: TranscriptViewOptions,
): Container {
  const container = new Container();
  const results = new Map<string, TranscriptMessage>();
  for (const message of messages) {
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string"
    ) {
      results.set(message.toolCallId, message);
    }
  }

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const entry = cachedMessage(message, options);
    container.addChild(entry.component);
    if (message.role === "assistant") {
      addToolCalls(container, entry, message, results, options);
    }
  }

  const { streaming } = options;
  if (streaming) {
    const entry = cachedMessage(streaming, options);
    (entry.component as AssistantMessageComponent).updateContent(
      streaming as never,
      true,
    );
    container.addChild(entry.component);
    addToolCalls(container, entry, streaming, results, options);
  }
  return container;
}

/**
 * Gives every tool row still showing a partial result a final one, which
 * stops its redraw timer. Call it when the run behind a live transcript ends.
 */
export function releaseTranscript(
  messages: Array<TranscriptMessage | undefined>,
): void {
  for (const message of messages) {
    const entry = message && cache.get(message);
    if (!entry) continue;
    for (const id of entry.running) {
      entry.tools.get(id)?.updateResult({
        content: [{ type: "text", text: "Stopped" }],
        isError: true,
      });
    }
    entry.running.clear();
  }
}

export function transcriptView(
  result: AgentResult,
  display: TranscriptDisplay,
): Container | undefined {
  const cwd = result.cwd ?? process.cwd();
  if (result.live) {
    return renderTranscript(result.live.messages, {
      cwd,
      streaming: result.live.streaming,
      pendingResults: result.live.pendingResults,
      ...display,
    });
  }
  if (!result.sessionFile || result.messageEnd === undefined) return undefined;
  return renderTranscript(
    loadTranscript(
      result.sessionFile,
      result.messageStart ?? 0,
      result.messageEnd,
    ),
    { cwd, ...display },
  );
}
