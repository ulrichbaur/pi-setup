import {
  CANCELLED,
  type DialogAnswer,
  type RpcChild,
  type RpcRecord,
} from "./rpc.ts";
import type { AgentResult } from "./types.ts";

const MAX_FINISHED_RUNS = 50;

export interface SubagentRun {
  readonly result: AgentResult;
  // Aborting it stops this run alone.
  readonly stop: AbortController;
  // Set while the child can still take messages.
  child?: RpcChild;
  readonly pendingDialogs: PendingDialog[];
}

export interface PendingDialog {
  readonly request: RpcRecord;
  answer(answer: DialogAnswer): void;
}

export type MessageMode = "steer" | "followUp";

export function isActive(run: SubagentRun): boolean {
  const { status } = run.result.progress;
  return status === "pending" || status === "running";
}

export class RunRegistry {
  private readonly runs: SubagentRun[] = [];
  private readonly listeners = new Set<() => void>();

  add(run: SubagentRun): void {
    this.runs.push(run);
    const finished = this.runs.filter((candidate) => !isActive(candidate));
    for (const old of finished.slice(0, -MAX_FINISHED_RUNS)) {
      this.runs.splice(this.runs.indexOf(old), 1);
    }
    this.changed();
  }

  /** Runs with the newest first. */
  list(): SubagentRun[] {
    return [...this.runs].reverse();
  }

  active(sessionId: string): SubagentRun | undefined {
    return this.runs.find(
      (run) => isActive(run) && run.result.sessionId === sessionId,
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** The result records the message, so the parent model learns about it. */
  async send(run: SubagentRun, text: string, mode: MessageMode): Promise<void> {
    const message = text.trim();
    if (!message) return;
    if (!run.child) throw new Error("This subagent is not running");
    await run.child.send(
      mode === "steer"
        ? { type: "steer", message }
        : { type: "follow_up", message },
    );
    run.result.userMessages = [...(run.result.userMessages ?? []), message];
    this.changed();
  }

  /** Queues a child dialog for an answer in /agents. */
  ask(
    run: SubagentRun,
    request: RpcRecord,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<DialogAnswer> {
    if (signal.aborted) return Promise.resolve(CANCELLED);
    const limit =
      typeof request.timeout === "number"
        ? Math.min(timeoutMs, request.timeout)
        : timeoutMs;
    return new Promise((resolve) => {
      const finish = (answer: DialogAnswer) => {
        const index = run.pendingDialogs.indexOf(question);
        if (index === -1) return;
        run.pendingDialogs.splice(index, 1);
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.changed();
        resolve(answer);
      };
      const cancel = () => finish(CANCELLED);
      const question: PendingDialog = { request, answer: finish };
      const timer = setTimeout(cancel, limit);
      timer.unref();
      signal.addEventListener("abort", cancel, { once: true });
      run.pendingDialogs.push(question);
      this.changed();
    });
  }

  stop(run: SubagentRun): void {
    if (isActive(run)) run.stop.abort();
  }

  activeRuns(): SubagentRun[] {
    return this.runs.filter(isActive);
  }

  /**
   * Resolves once all runs have ended, so their sessions are complete;
   * false on timeout.
   */
  stopAll(timeoutMs = 15_000): Promise<boolean> {
    for (const run of this.activeRuns()) run.stop.abort();
    return new Promise((resolve) => {
      const finish = (ended: boolean) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(ended);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const unsubscribe = this.subscribe(() => {
        if (this.activeRuns().length === 0) finish(true);
      });
      if (this.activeRuns().length === 0) finish(true);
    });
  }
}
