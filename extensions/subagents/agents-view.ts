import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { formatCost } from "../../lib/subagent-cost.ts";
import { statusIcon } from "./render.ts";
import { isActive, type RunRegistry, type SubagentRun } from "./runs.ts";
import { sameSession, sessionRows } from "./session-view.ts";
import { transcriptView } from "./transcript-view.ts";

const OVERLAY_HEIGHT_FRACTION = 0.85;

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface OverlayOptions {
  hideThinking: () => boolean;
}

export class AgentsOverlay implements Component {
  private view: "list" | "detail" = "list";
  private selected: SubagentRun | undefined;
  // 0 follows new output.
  private scrollFromEnd = 0;
  private viewportHeight = 1;
  private notice: { text: string; error: boolean } | undefined;
  private readonly border: DynamicBorder;
  private readonly separator: DynamicBorder;
  private readonly unsubscribe: () => void;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly registry: RunRegistry;
  private readonly done: () => void;
  private readonly options: OverlayOptions;

  constructor(
    tui: TUI,
    theme: Theme,
    registry: RunRegistry,
    done: () => void,
    options: OverlayOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.registry = registry;
    this.done = done;
    this.options = options;
    this.border = new DynamicBorder((text: string) => theme.fg("accent", text));
    this.separator = new DynamicBorder((text: string) =>
      theme.fg("borderMuted", text),
    );
    this.unsubscribe = registry.subscribe(() => tui.requestRender());
  }

  handleInput(data: string): void {
    if (this.view === "list") this.handleListInput(data);
    else this.handleDetailInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const maxHeight = Math.max(
      6,
      Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_FRACTION),
    );
    this.runs();
    const lines =
      this.view === "detail" && this.selected
        ? this.renderDetail(this.selected, width, maxHeight)
        : this.renderList(width, maxHeight);
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  private close(): void {
    this.unsubscribe();
    this.done();
  }

  private runs(): SubagentRun[] {
    const runs = sessionRows(this.registry.list());
    const selected = this.selected;
    this.selected =
      (selected && runs.find((run) => sameSession(run, selected))) ?? runs[0];
    return runs;
  }

  private handleListInput(data: string): void {
    const runs = this.runs();
    const index = this.selected ? runs.indexOf(this.selected) : -1;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q"
    ) {
      this.close();
    } else if (matchesKey(data, Key.up)) {
      this.selected = runs[Math.max(0, index - 1)];
    } else if (matchesKey(data, Key.down)) {
      this.selected = runs[Math.min(runs.length - 1, index + 1)];
    } else if (matchesKey(data, Key.enter) && this.selected) {
      this.open(this.selected);
    } else if (matchesKey(data, Key.ctrl("x")) && this.selected) {
      this.stop(this.selected);
    }
  }

  private scroll(data: string): void {
    if (matchesKey(data, Key.pageUp)) {
      this.scrollFromEnd += this.viewportHeight;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollFromEnd = Math.max(
        0,
        this.scrollFromEnd - this.viewportHeight,
      );
    }
  }

  private handleDetailInput(data: string): void {
    this.runs();
    const run = this.selected;
    if (!run) return;
    if (matchesKey(data, Key.escape)) {
      this.view = "list";
      this.notice = undefined;
    } else if (matchesKey(data, Key.ctrl("x"))) {
      this.stop(run);
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.scroll(data);
    }
  }

  private open(run: SubagentRun): void {
    this.selected = run;
    this.view = "detail";
    this.scrollFromEnd = 0;
    this.notice = undefined;
  }

  private stop(run: SubagentRun): void {
    if (!isActive(run)) return;
    this.registry.stop(run);
    this.notice = { text: "Stopping this subagent…", error: false };
  }

  private summary(run: SubagentRun): string {
    const { result } = run;
    return `${statusIcon(result, this.theme)} ${this.theme.bold(result.agent)}${result.agentSource ? ` [${result.agentSource}]` : ""} ${this.theme.fg(
      "dim",
      `${result.sessionId ?? ""} · ${result.progress.status} · ${result.progress.toolCount} tools · ${formatDuration(result.progress.durationMs)}${result.usage.cost > 0 ? ` · ${formatCost(result.usage.cost)}` : ""}`,
    )}`;
  }

  private chrome(
    width: number,
    header: string[],
    footer: string[],
  ): { top: string[]; bottom: string[] } {
    return {
      top: [...this.border.render(width), ...header],
      bottom: [
        ...this.separator.render(width),
        ...footer,
        ...this.border.render(width),
      ],
    };
  }

  private measureViewport(
    width: number,
    maxHeight: number,
    header: string[],
    footer: string[],
  ): number {
    const { top, bottom } = this.chrome(width, header, footer);
    return Math.max(1, maxHeight - top.length - bottom.length);
  }

  private frame(
    width: number,
    header: string[],
    body: string[],
    footer: string[],
  ): string[] {
    const { top, bottom } = this.chrome(width, header, footer);
    return [...top, ...body, ...bottom];
  }

  private renderList(width: number, maxHeight: number): string[] {
    const runs = this.runs();
    const header = [
      this.theme.fg("accent", this.theme.bold(` Subagents (${runs.length})`)),
    ];
    const body =
      runs.length === 0
        ? [this.theme.fg("dim", " No subagent has run in this session.")]
        : runs.flatMap((run) => {
            const marker =
              run === this.selected ? this.theme.fg("accent", "›") : " ";
            const task = run.result.task.replace(/\s+/g, " ");
            const asks =
              run.result.question && !isActive(run)
                ? this.theme.fg("warning", " · asks the parent")
                : "";
            return [
              `${marker} ${this.summary(run)}${asks}`,
              `    ${this.theme.fg("muted", truncateToWidth(task, Math.max(1, width - 4)))}`,
            ];
          });
    const footer = [
      this.theme.fg("dim", " ↑↓ select · Enter view · Ctrl+X stop · Esc close"),
    ];
    const selected = this.selected ? runs.indexOf(this.selected) : 0;
    const height = this.measureViewport(width, maxHeight, header, footer);
    // Each session takes two lines.
    const firstVisibleLine = Math.max(0, (selected + 1) * 2 - height);
    const visible = body.slice(firstVisibleLine, firstVisibleLine + height);
    return this.frame(width, header, visible, footer);
  }

  private scrolledFrame(
    width: number,
    maxHeight: number,
    header: string[],
    lines: string[],
    footer: string[],
  ): string[] {
    this.viewportHeight = this.measureViewport(
      width,
      maxHeight,
      header,
      footer,
    );
    const maxScroll = Math.max(0, lines.length - this.viewportHeight);
    this.scrollFromEnd = Math.min(this.scrollFromEnd, maxScroll);
    const end = lines.length - this.scrollFromEnd;
    const body = lines.slice(Math.max(0, end - this.viewportHeight), end);
    return this.frame(width, header, body, footer);
  }

  private renderDetail(
    run: SubagentRun,
    width: number,
    maxHeight: number,
  ): string[] {
    const header = [` ${this.summary(run)}`];
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

    const footer: string[] = [];
    if (this.notice) {
      footer.push(
        this.theme.fg(
          this.notice.error ? "error" : "dim",
          ` ${this.notice.text}`,
        ),
      );
    }
    if (isActive(run)) {
      footer.push(
        this.theme.fg(
          "dim",
          " Read-only · PgUp/PgDn scroll · Ctrl+X stop · Esc back",
        ),
      );
    } else {
      footer.push(
        this.theme.fg(
          "dim",
          " Finished: read-only · PgUp/PgDn scroll · Esc back",
        ),
      );
    }

    return this.scrolledFrame(width, maxHeight, header, lines, footer);
  }
}
