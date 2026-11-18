import { basename, dirname, join } from "node:path";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { findLogMatch } from "./log-search.ts";
import { LogViewport } from "./log-viewport.ts";
import { stopJob } from "./runner.ts";
import {
  active,
  displayJobId,
  type LogAnchor,
  LogLineIndex,
  markReviewed,
  readLogPage,
  type sessionTasks,
  type TaskRow,
  terminalText,
} from "./task-store.ts";

export function taskStatusLabel({ state, job }: TaskRow): string {
  const result =
    job.signal ?? (job.exitCode == null ? undefined : `exit ${job.exitCode}`);
  switch (state) {
    case "exited":
      return job.exitCode === 0
        ? "Completed (exit 0)"
        : `Failed${result ? ` (${result})` : ""}`;
    case "failed":
      return "Failed to start";
    case "stopped":
      return `Stopped${result ? ` (${result})` : ""}`;
    case "timed_out":
      return `Timed out${result ? ` (${result})` : ""}`;
    case "unknown":
      return "Status unknown";
    default:
      return state[0].toUpperCase() + state.slice(1);
  }
}

function elapsed(row: TaskRow): string {
  const start = Date.parse(row.job.startedAt ?? row.job.createdAt);
  const end = row.job.finishedAt ? Date.parse(row.job.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}

function canStop(row: TaskRow): boolean {
  return active(row) && row.state !== "stopping";
}

type Snapshot = Awaited<ReturnType<typeof sessionTasks>>;

export class TaskView {
  private snapshot: Snapshot;
  private selected?: string;
  private details?: string;
  private commandOffset?: number;
  private commandScroll = 0;
  private logRows = 12;
  private readonly viewport = new LogViewport((text, query) =>
    this.highlight(text, query),
  );
  private searchInput?: Input;
  private searchDirection: 1 | -1 = 1;
  private searchQuery = "";
  private searchLine?: number;
  private searchStatus?: string;
  private searchRequest?: AbortController;
  private logIndex = new LogLineIndex();
  private error?: string;
  private refreshBusy = false;
  private logRequest = 0;
  private logBusy = false;
  private stopBusy = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: () => void;
  private readonly load: () => Promise<Snapshot>;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    done: () => void,
    load: () => Promise<Snapshot>,
    snapshot: Snapshot,
    jobId?: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.load = load;
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
      if (this.details) {
        const row = this.row(this.details);
        if (row) {
          await markReviewed(row);
          if (this.viewport.following && !this.logBusy && !this.searchInput)
            await this.loadLog(row);
        } else {
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

  private async loadLog(
    row: TaskRow,
    anchor?: LogAnchor,
    atBottom = true,
  ): Promise<void> {
    const request = ++this.logRequest;
    this.logBusy = true;
    try {
      const page = await readLogPage(row.dir, anchor, this.logIndex);
      if (request !== this.logRequest || this.closed) return;
      this.viewport.setPage(page, atBottom);
    } catch (error) {
      if (request === this.logRequest) this.error = String(error);
    } finally {
      if (request === this.logRequest) this.logBusy = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private open(id: string): void {
    const row = this.row(id);
    if (!row) return;
    this.selected = id;
    this.details = id;
    this.viewport.setPage(undefined, true);
    this.viewport.resume();
    this.logIndex = new LogLineIndex();
    this.error = undefined;
    void markReviewed(row).catch((error) => {
      if (this.details !== id || this.closed) return;
      this.error = String(error);
      this.tui.requestRender();
    });
    void this.loadLog(row);
  }

  private back(): void {
    this.details = undefined;
    this.searchRequest?.abort();
    this.searchInput = undefined;
    this.searchQuery = "";
    this.searchLine = undefined;
    this.searchStatus = undefined;
    this.commandOffset = undefined;
    this.error = undefined;
    this.logRequest++;
    this.logBusy = false;
  }

  private async stop(row: TaskRow): Promise<void> {
    if (this.stopBusy || !canStop(row)) return;
    this.stopBusy = true;
    try {
      this.error = (await stopJob(row.dir))
        ? undefined
        : "Stop not accepted. The job may have already ended.";
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

  private scrollLog(delta: number): void {
    const row = this.row(this.details);
    if (!row || !this.viewport.page) return;
    if (delta < 0 && this.logBusy) {
      // A late tail read must not move the viewport after the user scrolls.
      this.logRequest++;
      this.logBusy = false;
    }
    const next = this.viewport.scroll(delta);
    if (next && (!this.logBusy || !next.anchor)) {
      void this.loadLog(row, next.anchor, next.atBottom);
    }
  }

  private async search(
    query: string,
    start: number,
    direction: 1 | -1,
  ): Promise<void> {
    const row = this.row(this.details);
    if (!row || !query) return;
    this.viewport.pause();
    this.logRequest++;
    this.logBusy = false;
    this.searchRequest?.abort();
    const request = new AbortController();
    this.searchRequest = request;
    this.searchStatus = "Searching…";
    try {
      const match = await findLogMatch(
        row.dir,
        query,
        start,
        direction,
        request.signal,
      );
      if (request.signal.aborted) return;
      this.searchLine = match?.line;
      this.searchStatus = match ? `Match on line ${match.line}` : "No matches";
      if (match) await this.loadLog(row, { after: match.offset }, false);
    } catch (error) {
      if (!request.signal.aborted)
        this.searchStatus = terminalText(String(error));
    } finally {
      if (this.searchRequest === request) this.searchRequest = undefined;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private logQuery(): string {
    return this.searchInput
      ? terminalText(this.searchInput.getValue())
      : this.searchQuery;
  }

  private highlight(line: string, query: string): string {
    if (!query || !line.includes(query)) return line;
    return line.split(query).join(this.theme.inverse(query));
  }

  handleInput(data: string): void {
    if (this.searchInput) {
      if (this.keys.matches(data, "tui.select.cancel"))
        this.searchInput = undefined;
      else if (this.keys.matches(data, "tui.select.confirm")) {
        this.searchQuery = terminalText(this.searchInput.getValue());
        this.searchInput = undefined;
        this.searchLine = undefined;
        this.searchStatus = undefined;
        if (this.searchQuery)
          void this.search(
            this.searchQuery,
            this.viewport.firstVisibleLine(),
            this.searchDirection,
          );
      } else this.searchInput.handleInput(data);
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
    } else if (this.details && matchesKey(data, "c")) {
      this.commandOffset = this.commandOffset === undefined ? 0 : undefined;
    } else if (matchesKey(data, "x")) {
      const row = this.row(this.details);
      if (row) void this.stop(row);
    } else if (this.commandOffset !== undefined && this.logRows === 0) {
      const step = pageUp
        ? -this.commandHeight()
        : pageDown
          ? this.commandHeight()
          : up
            ? -1
            : down
              ? 1
              : 0;
      this.commandOffset = Math.max(
        0,
        Math.min(this.commandScroll, this.commandOffset + step),
      );
    } else if (this.details) {
      if (matchesKey(data, "w")) this.viewport.toggleWrap();
      else if (
        matchesKey(data, "/") ||
        matchesKey(data, "?") ||
        matchesKey(data, "shift+/")
      ) {
        this.searchDirection = matchesKey(data, "/") ? 1 : -1;
        this.searchRequest?.abort();
        this.logRequest++;
        this.logBusy = false;
        this.searchInput = new Input();
        this.searchInput.focused = true;
      } else if (
        this.searchQuery &&
        (matchesKey(data, "n") || matchesKey(data, "shift+n"))
      ) {
        const direction = matchesKey(data, "shift+n") ? -1 : 1;
        const start =
          this.searchLine === undefined
            ? this.viewport.firstVisibleLine()
            : this.searchLine + direction;
        void this.search(this.searchQuery, start, direction);
      } else if (up || pageUp)
        this.scrollLog(pageUp ? -this.viewport.scrollHeight : -1);
      else if (down || pageDown)
        this.scrollLog(pageDown ? this.viewport.scrollHeight : 1);
      else if (matchesKey(data, "end")) {
        const row = this.row(this.details);
        this.searchRequest?.abort();
        this.searchStatus = undefined;
        this.viewport.resume();
        if (row) void this.loadLog(row);
      }
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
      const next = active(row)
        ? "Active"
        : row.state === "unknown"
          ? "Status unknown"
          : "History";
      if (next !== group) lines.push(this.theme.fg("muted", next));
      group = next;
      const selected = row.job.id === this.selected;
      const fresh = row.job.finishedAt && !row.reviewed ? " · unreviewed" : "";
      const line = `${selected ? ">" : " "} ${displayJobId(row.job.id, this.snapshot)} · ${taskStatusLabel(row)} · ${elapsed(row)}${fresh} · ${terminalText(row.job.label || row.job.command)}`;
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

  private detail(row: TaskRow, width: number): string[] {
    const { job } = row;
    const lines = [
      this.theme.fg("accent", terminalText(job.label || job.command)),
      `${taskStatusLabel(row)} · ${elapsed(row)} · Task ${displayJobId(job.id, this.snapshot)}`,
    ];
    const expanded = this.commandOffset !== undefined;
    const command = expanded
      ? wrapTextWithAnsi(
          `Command: ${job.command.split("\n").map(terminalText).join("\n")}`,
          Math.max(1, width - 4),
        )
      : [`Command: ${terminalText(job.command)}`];
    const commandHeight = this.commandHeight();
    this.commandScroll = Math.max(0, command.length - commandHeight);
    const commandOffset = Math.min(this.commandOffset ?? 0, this.commandScroll);
    if (expanded) this.commandOffset = commandOffset;
    lines.push(...command.slice(commandOffset, commandOffset + commandHeight));
    lines.push(
      `Log: …/${terminalText(join(basename(dirname(row.dir)), job.id, "output.log"))}`,
    );
    this.logRows = Math.max(0, this.popupHeight() - 8 - command.length);
    this.viewport.layout(width - 4, this.logRows, this.logQuery());
    const page = this.viewport.page;
    const position = this.viewport.following ? "following" : "paused";
    const searchStatus =
      this.searchStatus && !this.searchInput ? ` · ${this.searchStatus}` : "";
    const stop = canStop(row) ? " · x stop" : "";
    if (expanded && this.logRows === 0) {
      const scroll = this.commandScroll
        ? " · ↑↓ scroll command · u/d page"
        : "";
      lines.push(
        this.theme.fg("dim", `c collapse command${scroll}${stop} · Esc close`),
      );
      return lines;
    }
    if (!page) lines.push("Loading log…");
    else if (!page.lines.length) lines.push("No output yet.");
    else {
      const visible = this.viewport.visibleRows();
      const first = visible[0].line;
      const last = visible[visible.length - 1].line;
      const digits = String(page.totalLines).length;
      lines.push(
        this.theme.fg(
          "muted",
          `Output (${position}) · lines ${first}–${last} of ${page.totalLines}${searchStatus}`,
        ),
      );
      lines.push(
        ...visible.map(
          ({ line, text, continuation }) =>
            `${this.theme.fg("muted", (continuation ? "" : String(line)).padStart(digits))}  ${text}`,
        ),
      );
    }
    if (searchStatus && !page?.lines.length)
      lines.push(this.theme.fg("muted", this.searchStatus ?? ""));
    lines.push(
      this.searchInput
        ? `${this.searchDirection === 1 ? "Search: " : "Search backward: "}${this.searchInput.render(Math.max(1, width - (this.searchDirection === 1 ? 12 : 21)))[0] ?? ""}`
        : this.theme.fg(
            "dim",
            `${expanded ? "c collapse command" : "c full command"} · ${this.viewport.wrapping ? "w unwrap" : "w wrap"} · /? search${this.searchQuery ? " · n/N match" : ""} · ↑↓ scroll · End follow${stop} · Esc close`,
          ),
    );
    return lines;
  }

  private commandHeight(): number {
    return Math.max(1, this.popupHeight() - 7);
  }

  render(width: number): string[] {
    const row = this.details ? this.row(this.details) : undefined;
    const lines = row ? this.detail(row, width) : this.list();
    const error = this.error ?? row?.job.error ?? this.snapshot.errors[0];
    const height = this.popupHeight();
    if (width < 5 || height < 4) {
      return lines.slice(0, height).map((line) => truncateToWidth(line, width));
    }
    const hint = lines.pop() ?? "";
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
    this.searchRequest?.abort();
    clearInterval(this.timer);
  }
}
