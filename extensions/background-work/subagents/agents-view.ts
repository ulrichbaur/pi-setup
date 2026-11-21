import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { AgentDetail, agentRowText } from "./agent-detail.ts";
import { isActive, type RunRegistry, type SubagentRun } from "./runs.ts";
import { sameSession, sessionRows } from "./session-view.ts";

const OVERLAY_HEIGHT_FRACTION = 0.85;

export interface OverlayOptions {
  hideThinking: () => boolean;
}

export class AgentsOverlay implements Component {
  private selected: SubagentRun | undefined;
  private detail: AgentDetail | undefined;
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
    if (!this.detail) this.handleListInput(data);
    else if (this.detail.handleInput(data) === "back") {
      this.detail.dispose();
      this.detail = undefined;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const maxHeight = Math.max(
      6,
      Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_FRACTION),
    );
    this.runs();
    const lines =
      this.detail && this.selected
        ? this.renderDetail(this.detail, width, maxHeight)
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

  private open(run: SubagentRun): void {
    this.selected = run;
    this.detail = new AgentDetail(
      this.tui,
      this.theme,
      this.registry,
      () => {
        this.runs();
        return this.selected;
      },
      this.options,
    );
  }

  private stop(run: SubagentRun): void {
    if (isActive(run)) this.registry.stop(run);
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
              `${marker} ${agentRowText(run, this.theme)}${asks}`,
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

  private renderDetail(
    detail: AgentDetail,
    width: number,
    maxHeight: number,
  ): string[] {
    const { top, bottom } = this.chrome(width, [], []);
    const view = detail.render(width, maxHeight - top.length - bottom.length);
    const footer = view.notice
      ? [
          this.theme.fg(
            view.notice.error ? "error" : "dim",
            ` ${view.notice.text}`,
          ),
          view.hint,
        ]
      : [view.hint];
    return this.frame(
      width,
      view.lines.slice(0, 1),
      view.lines.slice(1),
      footer,
    );
  }
}
