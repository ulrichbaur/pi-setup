import type { AgentResult } from "./types.ts";

const MAX_FINISHED_RUNS = 50;

export interface SubagentRun {
  readonly result: AgentResult;
  startedAt?: number;
  // A restored launch without a saved completion has no recorded cost.
  undelivered?: boolean;
  // Aborting it stops this run alone.
  readonly stop: AbortController;
}

/** Who asked a run to stop. */
export type StopSource = "user" | "parent";

/** The abort reason of a run that was asked to stop. */
export class RunStop extends Error {
  readonly by: StopSource;
  constructor(by: StopSource) {
    super(
      by === "parent" ? "Stopped by the parent agent" : "Stopped by the user",
    );
    this.by = by;
  }
}

export function stoppedBy(run: SubagentRun): StopSource | undefined {
  const { reason } = run.stop.signal;
  return reason instanceof RunStop ? reason.by : undefined;
}

/** Names one background run by its run ID or by its session ID. */
export interface RunLookup {
  runId?: string;
  session?: string;
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

  /**
   * Finds one background run. A session resolves to its active run, or else
   * to its newest run.
   */
  find({ runId, session }: RunLookup): SubagentRun {
    if (runId !== undefined && session !== undefined)
      throw new Error("Pass runId or session, not both.");
    const background = this.list().filter((run) => run.result.runId);
    if (runId !== undefined) {
      const run = background.find((item) => item.result.runId === runId);
      if (!run) throw new Error(`Unknown background subagent run: ${runId}`);
      return run;
    }
    if (session === undefined) throw new Error("Pass runId or session.");
    const runs = background.filter((run) => run.result.sessionId === session);
    const run = runs.find(isActive) ?? runs[0];
    if (!run)
      throw new Error(
        `Unknown background subagent run for session: ${session}`,
      );
    return run;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  stop(run: SubagentRun, by: StopSource = "user"): void {
    if (isActive(run)) run.stop.abort(new RunStop(by));
  }
}
