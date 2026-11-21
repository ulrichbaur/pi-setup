import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  canStop,
  elapsed,
  requestStop,
  TaskDetail,
  taskStatusLabel,
} from "./task-detail.ts";
import {
  active,
  displayJobId,
  type sessionTasks,
  type TaskRow,
  terminalText,
} from "./task-store.ts";

type Snapshot = Awaited<ReturnType<typeof sessionTasks>>;

/** One job as a single list line, without the selection marker. */
export function taskRowText(row: TaskRow, snapshot: Snapshot): string {
  return `${displayJobId(row.job.id, snapshot)} · ${taskStatusLabel(row)} · ${elapsed(row)} · ${terminalText(row.job.label || row.job.command)}`;
}

export class TaskView {
  private snapshot: Snapshot;
  private selected?: string;
  private detail?: { id: string; pane: TaskDetail };
  private error?: string;
  private refreshBusy = false;
  private stopBusy = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: () => void;
  private readonly load: () => Promise<Snapshot>;
  private readonly stopJob: (id: string) => boolean;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    done: () => void,
    load: () => Promise<Snapshot>,
    stopJob: (id: string) => boolean,
    snapshot: Snapshot,
    jobId?: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.load = load;
    this.stopJob = stopJob;
    this.snapshot = snapshot;
    this.selected = snapshot.rows[0]?.job.id;
    if (jobId) this.open(jobId);
    this.timer = setInterval(() => void this.refresh(), 600);
    this.timer.unref();
  }

  private row(id = this.selected): TaskRow | undefined {
    return this.snapshot.rows.find((row) => row.job.id === id);
  }

  private async refresh(): Promise<void> {
    if (this.refreshBusy || this.closed) return;
    this.refreshBusy = true;
    try {
      const snapshot = await this.load();
      if (this.closed) return;
      this.snapshot = snapshot;
      if (!this.row()) this.selected = snapshot.rows[0]?.job.id;
      if (this.detail) {
        const row = this.row(this.detail.id);
        if (row) await this.detail.pane.update(row);
        else {
          this.back();
          this.error = "The job is no longer available.";
        }
      }
    } catch (error) {
      this.error = String(error);
    } finally {
      this.refreshBusy = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private open(id: string): void {
    const row = this.row(id);
    if (!row) return;
    this.selected = id;
    this.detail = {
      id,
      pane: new TaskDetail(this.tui, this.theme, this.keys, row, {
        stop: this.stopJob,
        refresh: () => this.refresh(),
        displayId: (jobId) => displayJobId(jobId, this.snapshot),
      }),
    };
    this.error = undefined;
  }

  private back(): void {
    this.detail?.pane.dispose();
    this.detail = undefined;
    this.error = undefined;
  }

  private async stop(row: TaskRow): Promise<void> {
    if (this.stopBusy || !canStop(row)) return;
    this.stopBusy = true;
    try {
      this.error = requestStop(row, this.stopJob);
      await this.refresh();
    } catch (error) {
      this.error = String(error);
    } finally {
      this.stopBusy = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private popupHeight(): number {
    return Math.max(1, Math.min(21, this.tui.terminal.rows - 2));
  }

  handleInput(data: string): void {
    if (this.detail) {
      // Escape in the details closes the whole popup.
      if (this.detail.pane.handleInput(data) === "back") {
        this.dispose();
        this.done();
        return;
      }
      this.tui.requestRender();
      return;
    }
    const up = this.keys.matches(data, "tui.select.up");
    const down = this.keys.matches(data, "tui.select.down");
    // Pi can reserve PageUp and PageDown for transcript scrolling.
    const pageUp =
      this.keys.matches(data, "tui.select.pageUp") || matchesKey(data, "u");
    const pageDown =
      this.keys.matches(data, "tui.select.pageDown") || matchesKey(data, "d");
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.done();
      return;
    } else if (matchesKey(data, "x")) {
      const row = this.row();
      if (row) void this.stop(row);
    } else if (up || down || pageUp || pageDown) {
      const { rows } = this.snapshot;
      const index = rows.findIndex((row) => row.job.id === this.selected);
      const step = pageUp ? -8 : pageDown ? 8 : up ? -1 : 1;
      this.selected =
        rows[Math.max(0, Math.min(rows.length - 1, index + step))]?.job.id;
    } else if (this.selected && this.keys.matches(data, "tui.select.confirm")) {
      this.open(this.selected);
    }
    this.tui.requestRender();
  }

  private list(): string[] {
    const { rows } = this.snapshot;
    const lines = [this.theme.fg("accent", "Background tasks")];
    const index = rows.findIndex((row) => row.job.id === this.selected);
    const height = Math.max(1, this.popupHeight() - 9);
    const start = Math.max(
      0,
      Math.min(index - Math.floor(height / 2), rows.length - height),
    );
    let group = "";
    for (const row of rows.slice(start, start + height)) {
      const next = active(row) ? "Active" : "History";
      if (next !== group) lines.push(this.theme.fg("muted", next));
      group = next;
      const selected = row.job.id === this.selected;
      const line = `${selected ? ">" : " "} ${taskRowText(row, this.snapshot)}`;
      lines.push(selected ? this.theme.fg("accent", line) : line);
    }
    if (!rows.length) lines.push("No background tasks in this session.");
    if (rows.length > height)
      lines.push(this.theme.fg("dim", `${index + 1}/${rows.length} jobs`));
    lines.push(
      this.theme.fg("dim", "↑↓ select · Enter details · x stop · Esc close"),
    );
    return lines;
  }

  render(width: number): string[] {
    const height = this.popupHeight();
    let lines: string[];
    let hint: string;
    let error = this.error;
    if (this.detail) {
      const view = this.detail.pane.render(width, height - 2);
      lines = view.lines;
      hint = view.hint;
      error ??= view.notice?.text;
    } else {
      lines = this.list();
      hint = lines.pop() ?? "";
    }
    error ??= this.snapshot.errors[0];
    if (width < 5 || height < 4) {
      return [...lines, hint]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    }
    const footer = error
      ? [this.theme.fg("error", terminalText(error)), hint]
      : [hint];
    const bodyHeight = height - 2 - footer.length;
    const content = lines.slice(0, bodyHeight);
    while (content.length < bodyHeight) content.push("");
    const innerWidth = width - 4;
    const border = (text: string) => this.theme.fg("borderMuted", text);
    const horizontal = "─".repeat(width - 2);
    return [
      border(`╭${horizontal}╮`),
      ...[...content, ...footer].map((line) => {
        const text = truncateToWidth(line, innerWidth);
        const padding = " ".repeat(
          Math.max(0, innerWidth - visibleWidth(text)),
        );
        return `${border("│")} ${text}${padding} ${border("│")}`;
      }),
      border(`╰${horizontal}╯`),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    this.detail?.pane.dispose();
    clearInterval(this.timer);
  }
}
