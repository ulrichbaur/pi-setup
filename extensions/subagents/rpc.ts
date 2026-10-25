import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/is-record.ts";

/** A stdout record other than a command response. */
export type RpcRecord = Record<string, unknown>;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STDERR_LIMIT = 16_000;

/**
 * Unlike Node's readline, keeps U+2028 and U+2029 inside a line and decodes
 * UTF-8 characters split across chunks.
 */
export function createLineSplitter(onLine: (line: string) => void): {
  write(chunk: Buffer): void;
  end(): void;
} {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emit = (line: string) =>
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    write(chunk) {
      buffer += decoder.write(chunk);
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        emit(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    end() {
      buffer += decoder.end();
      if (buffer) emit(buffer);
      buffer = "";
    },
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref());
}

/** The answer to an extension dialog, without the response envelope. */
export type DialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export const CANCELLED: DialogAnswer = { cancelled: true };

export type DialogHandler = (
  request: RpcRecord,
  childExited: AbortSignal,
) => Promise<DialogAnswer>;

/** Dialogs without a handler, or whose handler fails, get a cancel response. */
export class RpcChild {
  readonly exited: Promise<number>;
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly onDialog: DialogHandler | undefined;
  private readonly exitController = new AbortController();
  private readonly listeners = new Set<(record: RpcRecord) => void>();
  private readonly pending = new Map<
    string,
    { resolve(data: unknown): void; reject(error: Error): void }
  >();
  private nextId = 0;
  private stderrText = "";
  private hasExited = false;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    onDialog?: DialogHandler,
  ) {
    this.onDialog = onDialog;
    this.child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const splitter = createLineSplitter((line) => this.handleLine(line));
    this.child.stdout.on("data", (chunk: Buffer) => splitter.write(chunk));
    this.child.stdout.on("end", () => splitter.end());
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString()).slice(
        -STDERR_LIMIT,
      );
    });
    // A write to a dead child fails here; the exit handler reports it.
    this.child.stdin.on("error", () => {});

    this.exited = new Promise((resolve) => {
      const finish = (code: number) => {
        if (this.hasExited) return;
        this.hasExited = true;
        this.exitController.abort();
        const detail = this.stderr();
        const error = new Error(
          `Subagent process exited${detail ? `: ${detail}` : ""}`,
        );
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        resolve(code);
      };
      this.child.on("error", (error) => {
        this.stderrText += `${error.message}\n`;
        finish(1);
      });
      this.child.on("close", (code) => finish(code ?? 1));
    });
  }

  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(command: RpcCommand): Promise<unknown> {
    if (this.hasExited) {
      return Promise.reject(new Error("Subagent process has exited"));
    }
    this.nextId += 1;
    const id = `req-${this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ ...command, id });
    });
  }

  async abort(graceMs = 3_000): Promise<number> {
    await Promise.race([
      this.send({ type: "abort" }).catch(() => undefined),
      this.exited,
      sleep(graceMs),
    ]);
    return this.close(graceMs);
  }

  /**
   * Closes stdin so Pi shuts down and saves its session. Sends SIGTERM after
   * the grace period and SIGKILL after twice that.
   */
  async close(graceMs = 3_000): Promise<number> {
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), graceMs);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), graceMs * 2);
    try {
      return await this.exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }

  stderr(): string {
    return this.stderrText.trim();
  }

  private write(value: unknown): void {
    if (this.child.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(record)) return;

    if (record.type === "response") {
      const request =
        typeof record.id === "string" ? this.pending.get(record.id) : undefined;
      if (!request) return;
      this.pending.delete(record.id as string);
      if (record.success === true) request.resolve(record.data);
      else {
        request.reject(
          new Error(
            typeof record.error === "string"
              ? record.error
              : `${String(record.command)} failed`,
          ),
        );
      }
      return;
    }
    if (
      record.type === "extension_ui_request" &&
      typeof record.id === "string" &&
      DIALOG_METHODS.has(String(record.method))
    ) {
      this.answerDialog(record.id, record);
    }
    for (const listener of this.listeners) listener(record);
  }

  private answerDialog(id: string, request: RpcRecord): void {
    const respond = (answer: DialogAnswer) =>
      this.write({ type: "extension_ui_response", id, ...answer });
    if (!this.onDialog) {
      respond(CANCELLED);
      return;
    }
    this.onDialog(request, this.exitController.signal).then(respond, () =>
      respond(CANCELLED),
    );
  }
}
