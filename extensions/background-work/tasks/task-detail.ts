import { basename, dirname, join } from "node:path";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  type TUI,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { DetailPane, PaneView } from "../pane.ts";
import { findLogMatch } from "./log-search.ts";
import { LogViewport } from "./log-viewport.ts";
import {
  active,
  type LogAnchor,
  LogLineIndex,
  readLogPage,
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
    case "interrupted":
      return "Interrupted when Pi closed";
    default:
      return state[0].toUpperCase() + state.slice(1);
  }
}

export function elapsed(row: TaskRow): string {
  const start = Date.parse(row.job.startedAt ?? row.job.createdAt);
  const end = row.job.finishedAt ? Date.parse(row.job.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}

export function canStop(row: TaskRow): boolean {
  return active(row) && row.state !== "stopping";
}

/** Asks for a stop; returns the error to show, if any. */
export function requestStop(
  row: TaskRow,
  stop: (id: string) => boolean,
): string | undefined {
  return stop(row.job.id)
    ? undefined
    : "Stop not accepted. The job has ended or runs in another Pi process.";
}

export interface TaskDetailOptions {
  /** Stops a job; false when the stop was not accepted. */
  stop: (id: string) => boolean;
  /** Reloads the rows after a stop. */
  refresh: () => Promise<void>;
  /** The job's shortest unique ID prefix. */
  displayId: (id: string) => string;
}

/** A job's status, command, and log, with search and stop. */
export class TaskDetail implements DetailPane {
  private row: TaskRow;
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
  private readonly logIndex = new LogLineIndex();
  private error?: string;
  private logRequest = 0;
  private logBusy = false;
  private stopBusy = false;
  private closed = false;
  private height = 19;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly options: TaskDetailOptions;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    row: TaskRow,
    options: TaskDetailOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.row = row;
    this.options = options;
    this.viewport.setPage(undefined, true);
    this.viewport.resume();
    void this.loadLog();
  }

  /** Takes the job's latest record and follows new output. */
  async update(row: TaskRow): Promise<void> {
    this.row = row;
    if (this.viewport.following && !this.logBusy && !this.searchInput)
      await this.loadLog();
  }

  private async loadLog(anchor?: LogAnchor, atBottom = true): Promise<void> {
    const request = ++this.logRequest;
    this.logBusy = true;
    try {
      const page = await readLogPage(this.row.dir, anchor, this.logIndex);
      if (request !== this.logRequest || this.closed) return;
      this.viewport.setPage(page, atBottom);
    } catch (error) {
      if (request === this.logRequest) this.error = String(error);
    } finally {
      if (request === this.logRequest) this.logBusy = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private async stop(): Promise<void> {
    if (this.stopBusy || !canStop(this.row)) return;
    this.stopBusy = true;
    try {
      this.error = requestStop(this.row, this.options.stop);
      await this.options.refresh();
    } catch (error) {
      this.error = String(error);
    } finally {
      this.stopBusy = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private scrollLog(delta: number): void {
    if (!this.viewport.page) return;
    if (delta < 0 && this.logBusy) {
      // A late tail read must not move the viewport after the user scrolls.
      this.logRequest++;
      this.logBusy = false;
    }
    const next = this.viewport.scroll(delta);
    if (next && (!this.logBusy || !next.anchor)) {
      void this.loadLog(next.anchor, next.atBottom);
    }
  }

  private async search(
    query: string,
    start: number,
    direction: 1 | -1,
  ): Promise<void> {
    if (!query) return;
    this.viewport.pause();
    this.logRequest++;
    this.logBusy = false;
    this.searchRequest?.abort();
    const request = new AbortController();
    this.searchRequest = request;
    this.searchStatus = "Searching…";
    try {
      const match = await findLogMatch(
        this.row.dir,
        query,
        start,
        direction,
        request.signal,
      );
      if (request.signal.aborted) return;
      this.searchLine = match?.line;
      this.searchStatus = match ? `Match on line ${match.line}` : "No matches";
      if (match) await this.loadLog({ after: match.offset }, false);
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

  private commandHeight(): number {
    return Math.max(1, this.height - 5);
  }

  handleInput(data: string): "back" | "handled" {
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
      return "handled";
    }
    const up = this.keys.matches(data, "tui.select.up");
    const down = this.keys.matches(data, "tui.select.down");
    // Pi can reserve PageUp and PageDown for transcript scrolling.
    const pageUp =
      this.keys.matches(data, "tui.select.pageUp") || matchesKey(data, "u");
    const pageDown =
      this.keys.matches(data, "tui.select.pageDown") || matchesKey(data, "d");
    if (this.keys.matches(data, "tui.select.cancel")) return "back";
    if (matchesKey(data, "c")) {
      this.commandOffset = this.commandOffset === undefined ? 0 : undefined;
    } else if (matchesKey(data, "x")) {
      void this.stop();
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
    } else if (matchesKey(data, "w")) this.viewport.toggleWrap();
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
      this.searchRequest?.abort();
      this.searchStatus = undefined;
      this.viewport.resume();
      void this.loadLog();
    }
    return "handled";
  }

  render(width: number, height: number): PaneView {
    this.height = height;
    const { row } = this;
    const { job } = row;
    const error = this.error ?? job.error;
    const view = (lines: string[], hint: string): PaneView => ({
      lines,
      hint,
      ...(error && { notice: { text: terminalText(error), error: true } }),
    });
    const lines = [
      this.theme.fg("accent", terminalText(job.label || job.command)),
      `${taskStatusLabel(row)} · ${elapsed(row)} · Task ${this.options.displayId(job.id)}`,
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
    this.logRows = Math.max(0, height - 6 - command.length);
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
      return view(
        lines,
        this.theme.fg("dim", `c collapse command${scroll}${stop} · Esc close`),
      );
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
    return view(
      lines,
      this.searchInput
        ? `${this.searchDirection === 1 ? "Search: " : "Search backward: "}${this.searchInput.render(Math.max(1, width - (this.searchDirection === 1 ? 12 : 21)))[0] ?? ""}`
        : this.theme.fg(
            "dim",
            `${expanded ? "c collapse command" : "c full command"} · ${this.viewport.wrapping ? "w unwrap" : "w wrap"} · /? search${this.searchQuery ? " · n/N match" : ""} · ↑↓ scroll · End follow${stop} · Esc close`,
          ),
    );
  }

  dispose(): void {
    this.closed = true;
    this.searchRequest?.abort();
  }
}
