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
import type { DetailPane } from "./pane.ts";
import {
  buildSections,
  type Item,
  itemStatus,
  itemTitle,
  type Sections,
  type Snapshot,
  sectionItems,
} from "./rows.ts";
import { AgentDetail } from "./subagents/agent-detail.ts";
import type { SubagentsHandle } from "./subagents/register.ts";
import { isActive } from "./subagents/runs.ts";
import { sameSession, sessionRows } from "./subagents/session-view.ts";
import type { JobRegistry } from "./tasks/registry.ts";
import { canStop, requestStop, TaskDetail } from "./tasks/task-detail.ts";
import { displayJobId, terminalText } from "./tasks/task-store.ts";

const HEIGHT_FRACTION = 0.85;
const TICK_MS = 600;

/** The data the view shows. A feature that failed to load is missing. */
export interface ViewSources {
  tasks?: { registry: JobRegistry; load: () => Promise<Snapshot> };
  subagents?: SubagentsHandle;
  /** One message for each feature that failed to load. */
  unavailable: string[];
}

/** Shell jobs and subagents in one list, with a detail pane for each. */
export class BackgroundView {
  private snapshot?: Snapshot;
  private selected?: string;
  private detail?: { item: Item; pane: DetailPane };
  private error?: string;
  private reloading = false;
  private reloadAgain = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: () => void;
  private readonly sources: ViewSources;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    done: () => void,
    sources: ViewSources,
    snapshot: Snapshot | undefined,
    openKey?: string,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.sources = sources;
    this.snapshot = snapshot;
    this.selected = this.items()[0]?.key;
    if (openKey) this.open(openKey);
    if (sources.tasks)
      this.unsubscribe.push(
        sources.tasks.registry.subscribe(() => void this.reload()),
      );
    if (sources.subagents)
      this.unsubscribe.push(
        sources.subagents.registry.subscribe(() => this.tui.requestRender()),
      );
    // Elapsed times move, and an open log follows new output.
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  private sections(): Sections {
    const runs = this.sources.subagents
      ? sessionRows(this.sources.subagents.registry.list())
      : undefined;
    return buildSections(this.snapshot, runs);
  }

  private items(): Item[] {
    return sectionItems(this.sections());
  }

  private item(key = this.selected): Item | undefined {
    return this.items().find((item) => item.key === key);
  }

  private tick(): void {
    if (this.closed) return;
    const detail = this.detail;
    if (detail?.pane instanceof TaskDetail) {
      const item = this.item(detail.item.key);
      if (item?.kind === "task") void detail.pane.update(item.row);
    }
    this.tui.requestRender();
  }

  private async reload(): Promise<void> {
    if (!this.sources.tasks || this.closed) return;
    // A change during a read needs one more read after it.
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    this.reloading = true;
    try {
      this.snapshot = await this.sources.tasks.load();
      if (this.closed) return;
      const detail = this.detail;
      if (detail?.item.kind === "task") {
        const item = this.item(detail.item.key);
        if (item?.kind === "task" && detail.pane instanceof TaskDetail)
          await detail.pane.update(item.row);
        else {
          this.back();
          this.error = "The job is no longer available.";
        }
      }
    } catch (error) {
      this.error = String(error);
    } finally {
      this.reloading = false;
      if (this.reloadAgain && !this.closed) {
        this.reloadAgain = false;
        void this.reload();
      }
      if (!this.closed) this.tui.requestRender();
    }
  }

  private open(key: string): void {
    const item = this.item(key);
    if (!item) return;
    this.selected = key;
    this.error = undefined;
    const { tasks, subagents } = this.sources;
    if (item.kind === "task" && tasks) {
      const pane = new TaskDetail(this.tui, this.theme, this.keys, item.row, {
        stop: (id) => tasks.registry.stop(id),
        refresh: () => this.reload(),
        displayId: (id) =>
          this.snapshot ? displayJobId(id, this.snapshot) : id,
      });
      this.detail = { item, pane };
    } else if (item.kind === "agent" && subagents) {
      const latest = () =>
        sessionRows(subagents.registry.list()).find((run) =>
          sameSession(run, item.run),
        );
      const pane = new AgentDetail(
        this.tui,
        this.theme,
        subagents.registry,
        latest,
        subagents,
      );
      this.detail = { item, pane };
    }
  }

  private back(): void {
    this.detail?.pane.dispose();
    this.detail = undefined;
  }

  private stop(item: Item): void {
    const { tasks, subagents } = this.sources;
    if (item.kind === "task" && tasks) {
      if (!canStop(item.row)) return;
      this.error = requestStop(item.row, (id) => tasks.registry.stop(id));
      void this.reload();
    } else if (item.kind === "agent" && subagents && isActive(item.run)) {
      subagents.registry.stop(item.run);
    }
  }

  private height(): number {
    return Math.max(6, Math.floor(this.tui.terminal.rows * HEIGHT_FRACTION));
  }

  handleInput(data: string): void {
    if (this.detail) {
      if (this.detail.pane.handleInput(data) === "back") this.back();
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
    }
    const items = this.items();
    const index = items.findIndex((item) => item.key === this.selected);
    if (matchesKey(data, "x")) {
      const item = items[index];
      if (item) this.stop(item);
    } else if (up || down || pageUp || pageDown) {
      const step = pageUp ? -8 : pageDown ? 8 : up ? -1 : 1;
      this.selected =
        items[Math.max(0, Math.min(items.length - 1, index + step))]?.key;
    } else if (this.selected && this.keys.matches(data, "tui.select.confirm")) {
      this.open(this.selected);
    }
    this.tui.requestRender();
  }

  private rowLine(
    item: Item,
    widths: { id: number; status: number },
    selected: boolean,
  ): string {
    const status = itemStatus(item);
    const accent = (text: string) =>
      selected ? this.theme.fg("accent", text) : text;
    const statusText = status.text.padEnd(widths.status);
    return [
      accent(`${selected ? ">" : " "} ${item.kind.padEnd(5)}`),
      accent(item.shortId.padEnd(widths.id)),
      this.theme.fg(status.tone, statusText),
      accent(itemTitle(item)),
    ].join("  ");
  }

  private list(height: number): { lines: string[]; hint: string } {
    const sections = this.sections();
    const items = sectionItems(sections);
    if (!items.some((item) => item.key === this.selected))
      this.selected = items[0]?.key;
    const widths = {
      id: Math.min(
        24,
        Math.max(0, ...items.map((item) => item.shortId.length)),
      ),
      status: Math.min(
        32,
        Math.max(0, ...items.map((item) => itemStatus(item).text.length)),
      ),
    };
    const body: string[] = [];
    let selectedLine = 0;
    const section = (title: string, sectionItems: Item[]) => {
      if (!sectionItems.length) return;
      body.push(this.theme.fg("muted", title));
      for (const item of sectionItems) {
        const selected = item.key === this.selected;
        if (selected) selectedLine = body.length;
        body.push(this.rowLine(item, widths, selected));
      }
    };
    section("Active", sections.active);
    section("Shell history", sections.shellHistory);
    section("Subagent history", sections.subagentHistory);

    const head = [
      this.theme.fg("accent", "Background work"),
      ...this.sources.unavailable.map((message) =>
        this.theme.fg("error", terminalText(message)),
      ),
    ];
    if (!items.length) head.push("No background work in this session.");
    // The title, the hints, and an error line take a row each.
    const room = Math.max(1, height - head.length - 2);
    const start = Math.max(
      0,
      Math.min(selectedLine - Math.floor(room / 2), body.length - room),
    );
    return {
      lines: [...head, ...body.slice(start, start + room)],
      hint: this.theme.fg(
        "dim",
        "↑↓ select · Enter details · x stop · Esc close",
      ),
    };
  }

  render(width: number): string[] {
    const height = this.height();
    let lines: string[];
    let hint: string;
    let notice: { text: string; error: boolean } | undefined;
    if (this.detail) {
      const view = this.detail.pane.render(width, height - 2);
      ({ lines, hint, notice } = view);
    } else {
      ({ lines, hint } = this.list(height - 2));
    }
    // A view error comes before the pane's notice, an unreadable record after.
    const unreadable = this.snapshot?.errors[0];
    if (this.error) notice = { text: this.error, error: true };
    else if (!notice && unreadable) notice = { text: unreadable, error: true };
    if (width < 5 || height < 4) {
      return [...lines, hint]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    }
    const footer = notice
      ? [
          this.theme.fg(
            notice.error ? "error" : "dim",
            terminalText(notice.text),
          ),
          hint,
        ]
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
    if (this.closed) return;
    this.closed = true;
    this.back();
    clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}
