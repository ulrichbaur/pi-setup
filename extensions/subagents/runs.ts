import type { AgentResult } from "./types.ts";

const MAX_FINISHED_RUNS = 50;

export interface SubagentRun {
  readonly result: AgentResult;
  // Aborting it stops this run alone.
  readonly stop: AbortController;
}

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

  stop(run: SubagentRun): void {
    if (isActive(run)) run.stop.abort();
  }
}
