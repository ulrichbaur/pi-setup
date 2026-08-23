import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  type Component,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { BashRisk } from "./policy.ts";

type BashReviewChoice = "abort" | "run";

const OVERLAY_HEIGHT_FRACTION = 0.85;

export class BashReviewComponent implements Component {
  private readonly border: DynamicBorder;
  private readonly separator: DynamicBorder;
  private readonly actions: SelectList;
  private readonly commandText: Text;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private scrollOffset = 0;
  private commandViewportHeight = 1;
  private commandLineCount = 0;

  private readonly title: string;
  private readonly reasons: string;

  constructor(
    tui: TUI,
    theme: Theme,
    risk: BashRisk,
    command: string,
    done: (choice: BashReviewChoice) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.border = new DynamicBorder((text: string) =>
      this.theme.fg("warning", text),
    );
    this.separator = new DynamicBorder((text: string) =>
      this.theme.fg("borderMuted", text),
    );
    this.commandText = new Text(command, 1, 0);

    const items: SelectItem[] = [
      {
        value: "abort",
        label: "Abort",
        description: "Block this command and optionally give a reason",
      },
      {
        value: "run",
        label: "Run",
        description: "Execute this command once",
      },
    ];
    this.actions = new SelectList(items, items.length, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    this.actions.onSelect = (item) => done(item.value as BashReviewChoice);
    this.actions.onCancel = () => done("abort");

    this.title = `${risk.severity.toUpperCase()} risk bash command`;
    this.reasons = risk.reasons.map((reason) => `• ${reason}`).join("\n");
  }

  render(width: number): string[] {
    const titleLines = this.renderText(
      this.theme.fg("warning", this.theme.bold(this.title)),
      width,
    );
    const reasonLines = this.renderText(
      this.theme.fg("warning", this.reasons),
      width,
    );
    const commandLines = this.commandText.render(width);
    const actionLines = this.actions.render(width);
    const bottomBorder = this.border.render(width);
    const topBorder = this.border.render(width);

    const footer = [
      ...this.separator.render(width),
      ...actionLines,
      ...bottomBorder,
    ];
    const placeholderHeader = this.renderText(
      this.theme.fg("muted", "Command"),
      width,
    );
    const fullHeader = [
      ...topBorder,
      ...titleLines,
      ...reasonLines,
      ...this.separator.render(width),
      ...placeholderHeader,
    ];

    const maxHeight = this.maxOverlayHeight();
    const requiredBodyLines = commandLines.length > 0 ? 1 : 0;
    const maxBeforeLines = Math.max(
      0,
      maxHeight - footer.length - requiredBodyLines,
    );
    const before =
      fullHeader.length <= maxBeforeLines
        ? fullHeader
        : this.compactHeader(
            titleLines,
            placeholderHeader,
            topBorder,
            maxBeforeLines,
          );

    this.commandViewportHeight = Math.max(
      0,
      maxHeight - before.length - footer.length,
    );
    this.commandLineCount = commandLines.length;
    const maxOffset = Math.max(
      0,
      commandLines.length - this.commandViewportHeight,
    );
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const visibleCommandLines = commandLines.slice(
      this.scrollOffset,
      this.scrollOffset + this.commandViewportHeight,
    );
    const header = this.renderCommandHeader(width);
    const headerIndex = before.length - 1;
    const includesCommandHeader =
      headerIndex >= 0 && before[headerIndex] === placeholderHeader[0];
    const lines = [...before];
    if (includesCommandHeader) {
      lines[headerIndex] = header;
    }
    lines.push(...visibleCommandLines, ...footer);
    return lines.slice(0, maxHeight);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-this.commandViewportHeight);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(this.commandViewportHeight);
    } else if (matchesKey(data, Key.home)) {
      this.setScrollOffset(0);
    } else if (matchesKey(data, Key.end)) {
      this.setScrollOffset(this.commandLineCount);
    } else {
      this.actions.handleInput(data);
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.commandText.invalidate();
    this.actions.invalidate();
  }

  private renderText(text: string, width: number): string[] {
    return new Text(text, 1, 0).render(width);
  }

  private renderCommandHeader(width: number): string {
    const total = this.commandLineCount;
    const viewport = this.commandViewportHeight;
    const start = total === 0 ? 0 : this.scrollOffset + 1;
    const end = Math.min(total, this.scrollOffset + Math.max(1, viewport));
    const label =
      total > viewport
        ? `Command (lines ${start}-${end}/${total}; PgUp/PgDn scroll)`
        : "Command";
    return (
      this.renderText(
        this.theme.fg(
          "muted",
          truncateToWidth(label, Math.max(1, width - 2), ""),
        ),
        width,
      )[0] ?? ""
    );
  }

  private compactHeader(
    titleLines: string[],
    commandHeader: string[],
    topBorder: string[],
    maxLines: number,
  ): string[] {
    if (maxLines <= 0) return [];
    if (maxLines === 1) return titleLines.slice(0, 1);
    if (maxLines === 2) {
      return [...titleLines.slice(0, 1), ...commandHeader.slice(0, 1)];
    }
    return [
      ...topBorder.slice(0, 1),
      ...titleLines.slice(0, 1),
      ...commandHeader.slice(0, 1),
    ].slice(0, maxLines);
  }

  private maxOverlayHeight(): number {
    return Math.max(
      1,
      Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_FRACTION),
    );
  }

  private scrollBy(lines: number): void {
    this.setScrollOffset(this.scrollOffset + lines);
  }

  private setScrollOffset(offset: number): void {
    const maxOffset = Math.max(
      0,
      this.commandLineCount - this.commandViewportHeight,
    );
    const nextOffset = Math.max(0, Math.min(Math.trunc(offset), maxOffset));
    if (nextOffset === this.scrollOffset) {
      this.tui.requestRender();
      return;
    }
    this.scrollOffset = nextOffset;
    this.tui.requestRender();
  }
}

export type { BashReviewChoice };
