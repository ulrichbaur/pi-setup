import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { formatCost } from "../../../lib/subagent-cost.ts";
import type { DetailPane, PaneView } from "../pane.ts";
import { statusIcon, statusLabel } from "./render.ts";
import { isActive, type RunRegistry, type SubagentRun } from "./runs.ts";
import { transcriptView } from "./transcript-view.ts";

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** One run as a single summary line. */
export function agentRowText(run: SubagentRun, theme: Theme): string {
  const { result } = run;
  return `${statusIcon(result, theme)} ${theme.bold(result.agent)} ${theme.fg(
    "dim",
    `${result.sessionId} · ${statusLabel(result)} · ${result.progress.toolCount} tools · ${formatDuration(result.progress.durationMs)}${result.usage.cost > 0 ? ` · ${formatCost(result.usage.cost)}` : ""}`,
  )}`;
}

export interface AgentDetailOptions {
  hideThinking: () => boolean;
}

/** A run's read-only transcript, with scrolling and stop. */
export class AgentDetail implements DetailPane {
  // 0 follows new output.
  private scrollFromEnd = 0;
  private viewportHeight = 1;
  private notice: { text: string; error: boolean } | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly registry: RunRegistry;
  private readonly run: () => SubagentRun | undefined;
  private readonly options: AgentDetailOptions;

  /** `run` returns the latest run of the session the pane shows. */
  constructor(
    tui: TUI,
    theme: Theme,
    registry: RunRegistry,
    run: () => SubagentRun | undefined,
    options: AgentDetailOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.registry = registry;
    this.run = run;
    this.options = options;
  }

  handleInput(data: string): "back" | "handled" {
    const run = this.run();
    if (!run) return "handled";
    if (matchesKey(data, Key.escape)) return "back";
    if (matchesKey(data, "x")) {
      if (isActive(run)) {
        this.registry.stop(run);
        this.notice = { text: "Stopping this subagent…", error: false };
      }
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollFromEnd += this.viewportHeight;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollFromEnd = Math.max(
        0,
        this.scrollFromEnd - this.viewportHeight,
      );
    }
    return "handled";
  }

  render(width: number, height: number): PaneView {
    const run = this.run();
    if (!run) return { lines: [], hint: "" };
    const header = agentRowText(run, this.theme);
    let lines: string[];
    try {
      const transcript = transcriptView(
        run.result,
        {
          invalidate: () => this.tui.requestRender(),
          hideThinking: this.options.hideThinking(),
        },
        true,
      );
      lines = transcript
        ? transcript.render(width)
        : (run.result.output || "(no output yet)")
            .split("\n")
            .map((line) => ` ${line}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines = [this.theme.fg("warning", ` Transcript unavailable: ${message}`)];
    }
    if (run.result.progress.error) {
      lines.push(
        this.theme.fg("error", ` Error: ${run.result.progress.error}`),
      );
    }
    if (run.result.progress.warning) {
      lines.push(
        this.theme.fg("warning", ` Warning: ${run.result.progress.warning}`),
      );
    }
    const hint = this.theme.fg(
      "dim",
      isActive(run)
        ? "Read-only · PgUp/PgDn scroll · x stop · Esc back"
        : "Finished: read-only · PgUp/PgDn scroll · Esc back",
    );

    // The header, the notice, and the hints take a row each.
    this.viewportHeight = Math.max(1, height - 2 - (this.notice ? 1 : 0));
    const maxScroll = Math.max(0, lines.length - this.viewportHeight);
    this.scrollFromEnd = Math.min(this.scrollFromEnd, maxScroll);
    const end = lines.length - this.scrollFromEnd;
    const body = lines.slice(Math.max(0, end - this.viewportHeight), end);
    return {
      lines: [header, ...body],
      hint,
      ...(this.notice && { notice: this.notice }),
    };
  }

  dispose(): void {}
}
