import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/is-record.ts";
import type { RunRegistry } from "./runs.ts";
import { findSession, SESSIONS_DIR, sessionIdOf } from "./sessions.ts";
import { countMessageEntries, loadTranscript } from "./transcript.ts";

// A switch replaces the extension runtime, so the way back lives on disk.
export const RETURNS_PATH = join(getAgentDir(), "subagents", "returns.json");
const NOTE_LIMIT = 2_000;

/** Where a subagent session was opened from, and how long it was then. */
export interface ReturnPoint {
  parent: string;
  messages: number;
}

export function readReturns(
  path: string = RETURNS_PATH,
): Record<string, ReturnPoint> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path}: invalid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${path}: expected a JSON object`);
  const returns: Record<string, ReturnPoint> = {};
  for (const [session, point] of Object.entries(value)) {
    if (
      !isRecord(point) ||
      typeof point.parent !== "string" ||
      typeof point.messages !== "number"
    ) {
      throw new Error(`${path}: ${session} has no valid return point`);
    }
    returns[session] = { parent: point.parent, messages: point.messages };
  }
  return returns;
}

function writeReturns(
  returns: Record<string, ReturnPoint>,
  path: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(returns, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Also drops points whose files no longer exist. */
export function recordReturn(
  session: string,
  parent: string,
  path: string = RETURNS_PATH,
): void {
  const returns = readReturns(path);
  for (const [key, point] of Object.entries(returns)) {
    if (!existsSync(key) || !existsSync(point.parent)) delete returns[key];
  }
  returns[session] = { parent, messages: countMessageEntries(session) };
  writeReturns(returns, path);
}

export function takeReturn(
  session: string,
  path: string = RETURNS_PATH,
): ReturnPoint | undefined {
  const returns = readReturns(path);
  const point = returns[session];
  if (!point) return undefined;
  delete returns[session];
  writeReturns(returns, path);
  return point;
}

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

/** Undefined when the session did not grow since it was opened. */
export function returnNote(
  session: string,
  sessionId: string,
  point: ReturnPoint,
): string | undefined {
  const messages = countMessageEntries(session);
  if (messages <= point.messages) return undefined;
  const added = loadTranscript(session, point.messages, messages);
  const answer = added
    .filter((message) => message.role === "assistant")
    .map((message) => text(message.content).trim())
    .filter(Boolean)
    .at(-1);
  let note = `The user continued subagent session ${sessionId} directly.`;
  if (answer) {
    const shown =
      answer.length > NOTE_LIMIT ? `${answer.slice(0, NOTE_LIMIT)}…` : answer;
    note += ` Its last answer:\n\n${shown}`;
  }
  return `${note}\n\nResume it with this session id to build on that work.`;
}

// The custom message that tells the parent model about the user's work.
export const RETURN_MESSAGE_TYPE = "subagent-return";

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function report(notify: Notify, error: unknown): void {
  notify(error instanceof Error ? error.message : String(error), "error");
}

export async function openSubagentSession(
  ctx: ExtensionCommandContext,
  registry: RunRegistry,
  id: string,
): Promise<void> {
  const notify: Notify = (message, type) => ctx.ui.notify(message, type);
  if (!ctx.isIdle()) {
    notify(
      "Wait until the current run ends before opening a session.",
      "warning",
    );
    return;
  }
  const target = findSession(id);
  if (!target) {
    notify(`Unknown subagent session ${id} in ${SESSIONS_DIR}`, "error");
    return;
  }
  const parent = ctx.sessionManager.getSessionFile();
  if (!parent) {
    notify("This session is not saved, so Pi could not return to it.", "error");
    return;
  }
  if (parent === target) {
    notify(`This is already subagent session ${id}.`, "info");
    return;
  }

  const running = registry.activeRuns().length;
  if (running > 0) {
    const confirmed = await ctx.ui.confirm(
      `Stop ${running} running subagent${running > 1 ? "s" : ""}?`,
      "Opening a session closes this one, which stops them. Their sessions stay saved.",
    );
    if (!confirmed) return;
    if (!(await registry.stopAll())) {
      notify(
        "Running subagents did not stop in time; nothing was opened.",
        "error",
      );
      return;
    }
  }

  try {
    recordReturn(target, parent);
  } catch (error) {
    report(notify, error);
    return;
  }
  const { cancelled } = await ctx.switchSession(target);
  if (cancelled) takeReturn(target);
}

export async function returnToParent(
  ctx: ExtensionCommandContext,
): Promise<void> {
  const notify: Notify = (message, type) => ctx.ui.notify(message, type);
  const current = ctx.sessionManager.getSessionFile();
  let point: ReturnPoint | undefined;
  try {
    point = current ? readReturns()[current] : undefined;
  } catch (error) {
    report(notify, error);
    return;
  }
  if (!current || !point) {
    notify("No parent session is recorded for this session.", "warning");
    return;
  }
  if (!existsSync(point.parent)) {
    notify(`${point.parent}: the parent session no longer exists`, "error");
    return;
  }
  if (!ctx.isIdle()) {
    notify("Wait until the current run ends before going back.", "warning");
    return;
  }

  const note = returnNote(current, sessionIdOf(current), point);
  const { cancelled } = await ctx.switchSession(point.parent, {
    withSession: async (parentCtx) => {
      if (!note) return;
      await parentCtx.sendMessage(
        { customType: RETURN_MESSAGE_TYPE, content: note, display: true },
        { deliverAs: "nextTurn" },
      );
    },
  });
  if (!cancelled) takeReturn(current);
}
