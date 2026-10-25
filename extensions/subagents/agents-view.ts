import { basename } from "node:path";
import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { CANCELLED } from "./rpc.ts";
import type {
  MessageMode,
  PendingDialog,
  RunRegistry,
  SubagentRun,
} from "./runs.ts";
import type { SavedSession } from "./sessions.ts";
import { loadTranscript } from "./transcript.ts";
import { renderTranscript, transcriptView } from "./transcript-view.ts";

const OVERLAY_HEIGHT_FRACTION = 0.85;

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export type OverlayChoice = { open: string } | undefined;

export interface OverlayOptions {
  hideThinking: () => boolean;
  savedSessions: () => SavedSession[];
}

function formatAgo(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// An item value no select option can have.
const DISMISS = "\u0000dismiss";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isChoice(question: PendingDialog): boolean {
  const { method } = question.request;
  return method === "select" || method === "confirm";
}

function isActive(run: SubagentRun): boolean {
  const { status } = run.result.progress;
  return status === "pending" || status === "running";
}

export class AgentsOverlay implements Component, Focusable {
  private view: "list" | "detail" | "saved" | "savedDetail" = "list";
  private selected: SubagentRun | undefined;
  private saved: SavedSession[] = [];
  private selectedSaved: SavedSession | undefined;
  // 0 follows new output.
  private scrollFromEnd = 0;
  private viewportHeight = 1;
  private notice: { text: string; error: boolean } | undefined;
  private readonly input = new Input({ prompt: "› " });
  private readonly answerInput = new Input({ prompt: "Answer › " });
  private answerList: { question: PendingDialog; list: SelectList } | undefined;
  private readonly border: DynamicBorder;
  private readonly separator: DynamicBorder;
  private readonly unsubscribe: () => void;
  private isFocused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly registry: RunRegistry;
  private readonly done: (choice: OverlayChoice) => void;
  private readonly options: OverlayOptions;

  constructor(
    tui: TUI,
    theme: Theme,
    registry: RunRegistry,
    done: (choice: OverlayChoice) => void,
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
    this.input.onSubmit = (value) => this.send(value, "steer");
    this.answerInput.onSubmit = (value) => {
      const question = this.selected?.pendingDialogs[0];
      if (question) this.answer(question, value);
    };
    this.unsubscribe = registry.subscribe(() => tui.requestRender());
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.updateFocus();
  }

  private updateFocus(): void {
    const question = this.selected?.pendingDialogs[0];
    const detail = this.isFocused && this.view === "detail";
    const answering = question !== undefined && !isChoice(question);
    this.input.focused = detail && !answering;
    this.answerInput.focused = detail && answering;
  }

  handleInput(data: string): void {
    if (this.view === "list") this.handleListInput(data);
    else if (this.view === "detail") this.handleDetailInput(data);
    else if (this.view === "saved") this.handleSavedInput(data);
    else this.handleSavedDetailInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const maxHeight = Math.max(
      6,
      Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_FRACTION),
    );
    let lines: string[];
    if (this.view === "detail" && this.selected) {
      lines = this.renderDetail(this.selected, width, maxHeight);
    } else if (this.view === "saved") {
      lines = this.renderSaved(width, maxHeight);
    } else if (this.view === "savedDetail" && this.selectedSaved) {
      lines = this.renderSavedDetail(this.selectedSaved, width, maxHeight);
    } else {
      lines = this.renderList(width, maxHeight);
    }
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {
    this.input.invalidate();
    this.answerInput.invalidate();
  }

  private close(choice?: OverlayChoice): void {
    this.unsubscribe();
    this.done(choice);
  }

  // Only the command context can switch sessions.
  private openSession(run: SubagentRun): void {
    if (run.result.sessionId) this.close({ open: run.result.sessionId });
  }

  private runs(): SubagentRun[] {
    const runs = this.registry.list();
    if (!this.selected || !runs.includes(this.selected)) {
      this.selected = runs[0];
    }
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
    } else if (matchesKey(data, Key.ctrl("o")) && this.selected) {
      this.openSession(this.selected);
    } else if (matchesKey(data, Key.tab)) {
      this.showSaved();
    }
  }

  private showSaved(): void {
    this.saved = this.options.savedSessions();
    if (!this.selectedSaved || !this.saved.includes(this.selectedSaved)) {
      this.selectedSaved = this.saved.find(
        (session) => session.id === this.selectedSaved?.id,
      );
      this.selectedSaved ??= this.saved[0];
    }
    this.view = "saved";
  }

  private handleSavedInput(data: string): void {
    const index = this.selectedSaved
      ? this.saved.indexOf(this.selectedSaved)
      : -1;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q"
    ) {
      this.close();
    } else if (matchesKey(data, Key.tab)) {
      this.view = "list";
    } else if (matchesKey(data, Key.up)) {
      this.selectedSaved = this.saved[Math.max(0, index - 1)];
    } else if (matchesKey(data, Key.down)) {
      this.selectedSaved =
        this.saved[Math.min(this.saved.length - 1, index + 1)];
    } else if (matchesKey(data, Key.enter) && this.selectedSaved) {
      this.view = "savedDetail";
      this.scrollFromEnd = 0;
    } else if (matchesKey(data, Key.ctrl("o")) && this.selectedSaved) {
      this.close({ open: this.selectedSaved.id });
    }
  }

  private handleSavedDetailInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.view = "saved";
    } else if (matchesKey(data, Key.ctrl("o")) && this.selectedSaved) {
      this.close({ open: this.selectedSaved.id });
    } else {
      this.scroll(data);
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
    const run = this.selected;
    if (!run) return;
    const question = run.pendingDialogs[0];
    if (matchesKey(data, Key.escape)) {
      this.view = "list";
      this.updateFocus();
      this.notice = undefined;
    } else if (matchesKey(data, Key.ctrl("x"))) {
      this.stop(run);
    } else if (matchesKey(data, Key.ctrl("o"))) {
      this.openSession(run);
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.scroll(data);
    } else if (question && isChoice(question)) {
      this.questionList(question).handleInput(data);
    } else if (question) {
      this.answerInput.handleInput(data);
    } else if (matchesKey(data, Key.alt("enter"))) {
      this.send(this.input.getValue(), "followUp");
    } else if (isActive(run)) {
      this.input.handleInput(data);
    }
  }

  private open(run: SubagentRun): void {
    this.selected = run;
    this.view = "detail";
    this.scrollFromEnd = 0;
    this.notice = undefined;
    this.input.setValue("");
    this.updateFocus();
  }

  private questionList(question: PendingDialog): SelectList {
    if (this.answerList?.question === question) return this.answerList.list;
    const { request } = question;
    const options = Array.isArray(request.options)
      ? request.options.filter(
          (option): option is string => typeof option === "string",
        )
      : [];
    const items: SelectItem[] =
      request.method === "confirm"
        ? [
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]
        : [
            ...options.map((option) => ({ value: option, label: option })),
            { value: DISMISS, label: "Dismiss" },
          ];
    const list = new SelectList(items, Math.min(items.length, 8), {
      selectedPrefix: (value) => this.theme.fg("accent", value),
      selectedText: (value) => this.theme.fg("accent", value),
      description: (value) => this.theme.fg("muted", value),
      scrollInfo: (value) => this.theme.fg("dim", value),
      noMatch: (value) => this.theme.fg("warning", value),
    });
    list.onSelect = (item) => this.answer(question, item.value);
    this.answerList = { question, list };
    return list;
  }

  private answer(question: PendingDialog, value: string): void {
    if (question.request.method === "confirm") {
      question.answer({ confirmed: value === "yes" });
    } else if (value === DISMISS || !value.trim()) {
      question.answer(CANCELLED);
    } else {
      question.answer({ value });
    }
    this.answerInput.setValue("");
    this.notice = { text: "Answered.", error: false };
    this.updateFocus();
  }

  private stop(run: SubagentRun): void {
    if (!isActive(run)) return;
    this.registry.stop(run);
    this.notice = { text: "Stopping this subagent…", error: false };
  }

  private send(value: string, mode: MessageMode): void {
    const run = this.selected;
    if (!run || !value.trim()) return;
    // Clear at once, so text typed while the child answers is kept apart.
    this.input.setValue("");
    this.registry.send(run, value, mode).then(
      () => {
        this.notice = {
          text:
            mode === "steer"
              ? "Sent. The subagent reads it after its current turn."
              : "Queued. The subagent reads it when it would stop.",
          error: false,
        };
        this.tui.requestRender();
      },
      (error: unknown) => {
        if (!this.input.getValue()) this.input.setValue(value);
        this.notice = {
          text: error instanceof Error ? error.message : String(error),
          error: true,
        };
        this.tui.requestRender();
      },
    );
  }

  private statusIcon(run: SubagentRun): string {
    switch (run.result.progress.status) {
      case "running":
        return this.theme.fg("warning", "⟳");
      case "pending":
        return this.theme.fg("dim", "○");
      case "completed":
        return this.theme.fg("success", "✓");
      default:
        return this.theme.fg("error", "✗");
    }
  }

  private summary(run: SubagentRun): string {
    const { result } = run;
    return `${this.statusIcon(run)} ${this.theme.bold(result.agent)} ${this.theme.fg(
      "dim",
      `${result.sessionId ?? ""} · ${result.progress.status} · ${result.progress.toolCount} tools · ${formatDuration(result.progress.durationMs)}`,
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
            const waiting = run.pendingDialogs.length
              ? this.theme.fg("warning", " · waiting for your answer")
              : "";
            return [
              `${marker} ${this.summary(run)}${waiting}`,
              `    ${this.theme.fg("muted", truncateToWidth(task, Math.max(1, width - 4)))}`,
            ];
          });
    const footer = [
      this.theme.fg(
        "dim",
        " ↑↓ select · Enter view · Ctrl+O open session · Ctrl+X stop · Tab saved · Esc close",
      ),
    ];
    const selected = this.selected ? runs.indexOf(this.selected) : 0;
    return this.listFrame(width, maxHeight, header, body, footer, selected, 2);
  }

  private listFrame(
    width: number,
    maxHeight: number,
    header: string[],
    body: string[],
    footer: string[],
    selectedIndex: number,
    linesPerItem: number,
  ): string[] {
    const height = this.measureViewport(width, maxHeight, header, footer);
    const firstVisibleLine = Math.max(
      0,
      (selectedIndex + 1) * linesPerItem - height,
    );
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

  private renderSaved(width: number, maxHeight: number): string[] {
    const header = [
      this.theme.fg(
        "accent",
        this.theme.bold(` Saved subagent sessions (${this.saved.length})`),
      ),
    ];
    const now = Date.now();
    const body =
      this.saved.length === 0
        ? [this.theme.fg("dim", " No saved subagent sessions.")]
        : this.saved.flatMap((session) => {
            const marker =
              session === this.selectedSaved
                ? this.theme.fg("accent", "›")
                : " ";
            const project = session.cwd ? ` · ${basename(session.cwd)}` : "";
            return [
              `${marker} ${this.theme.bold(session.name)}`,
              `    ${this.theme.fg("dim", `${session.id} · ${formatAgo(now - session.modifiedMs)}${project}`)}`,
            ];
          });
    const footer = [
      this.theme.fg(
        "dim",
        " ↑↓ select · Enter view · Ctrl+O open session · Tab runs · Esc close",
      ),
    ];
    const selected = this.selectedSaved
      ? this.saved.indexOf(this.selectedSaved)
      : 0;
    return this.listFrame(width, maxHeight, header, body, footer, selected, 2);
  }

  private renderSavedDetail(
    session: SavedSession,
    width: number,
    maxHeight: number,
  ): string[] {
    const header = [
      ` ${this.theme.bold(session.name)} ${this.theme.fg("dim", session.id)}`,
    ];
    let lines: string[];
    try {
      lines = renderTranscript(
        loadTranscript(session.path, 0, Number.POSITIVE_INFINITY),
        {
          cwd: session.cwd || process.cwd(),
          invalidate: () => this.tui.requestRender(),
          hideThinking: this.options.hideThinking(),
        },
      ).render(width);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines = [this.theme.fg("warning", ` Transcript unavailable: ${message}`)];
    }
    const footer = [
      this.theme.fg(
        "dim",
        " Read-only · PgUp/PgDn scroll · Ctrl+O open session · Esc back",
      ),
    ];
    return this.scrolledFrame(width, maxHeight, header, lines, footer);
  }

  private renderDetail(
    run: SubagentRun,
    width: number,
    maxHeight: number,
  ): string[] {
    const header = [` ${this.summary(run)}`];
    let lines: string[];
    try {
      const transcript = transcriptView(run.result, {
        invalidate: () => this.tui.requestRender(),
        hideThinking: this.options.hideThinking(),
      });
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

    const active = isActive(run);
    const question = run.pendingDialogs[0];
    this.updateFocus();
    const footer: string[] = [];
    if (this.notice) {
      footer.push(
        this.theme.fg(
          this.notice.error ? "error" : "dim",
          ` ${this.notice.text}`,
        ),
      );
    }
    if (question) {
      footer.push(
        this.theme.fg("warning", ` ? ${text(question.request.title)}`),
      );
      const message = text(question.request.message);
      if (message) {
        footer.push(...message.split("\n").map((line) => `   ${line}`));
      }
      if (isChoice(question)) {
        footer.push(...this.questionList(question).render(width));
      } else {
        footer.push(...this.answerInput.render(width));
      }
      footer.push(
        this.theme.fg(
          "dim",
          isChoice(question)
            ? " ↑↓ choose · Enter answer · PgUp/PgDn · Ctrl+X stop · Esc back"
            : " Enter answer (empty dismisses) · PgUp/PgDn · Ctrl+X stop · Esc back",
        ),
      );
    } else if (active) {
      footer.push(...this.input.render(width));
      footer.push(
        this.theme.fg(
          "dim",
          " Enter steer · Alt+Enter follow-up · PgUp/PgDn · Ctrl+O open session · Ctrl+X stop · Esc back",
        ),
      );
    } else {
      footer.push(
        this.theme.fg(
          "dim",
          " Finished: read-only · PgUp/PgDn scroll · Ctrl+O open session · Esc back",
        ),
      );
    }

    return this.scrolledFrame(width, maxHeight, header, lines, footer);
  }
}
