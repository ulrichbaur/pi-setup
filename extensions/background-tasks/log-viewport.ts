import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { LogAnchor, LogPage } from "./task-store.ts";

type LogRow = { line: number; text: string; continuation: boolean };
type Navigation = { anchor?: LogAnchor; atBottom: boolean };

/** Tracks visual rows separately from the byte pages and original line numbers. */
export class LogViewport {
  page?: LogPage;
  following = true;
  wrapping = false;
  private offset = 0;
  private width = 80;
  private height = 12;
  private query = "";
  private rowsCache?: { page: LogPage; rows: LogRow[] };
  private readonly highlight: (text: string, query: string) => string;

  constructor(highlight: (text: string, query: string) => string) {
    this.highlight = highlight;
  }

  setPage(page: LogPage | undefined, atBottom: boolean): void {
    this.page = page;
    this.offset = atBottom ? Number.POSITIVE_INFINITY : 0;
    this.rowsCache = undefined;
  }

  layout(width: number, height: number, query: string): void {
    const reflow =
      this.wrapping && (width !== this.width || query !== this.query);
    if (!this.following && (reflow || height !== this.height)) {
      this.offset = this.visibleOffset(this.rows().length);
    }
    const line =
      reflow && !this.following ? this.firstVisibleLine() : undefined;
    this.width = width;
    this.height = height;
    this.query = query;
    if (reflow) this.rowsCache = undefined;
    if (line !== undefined) this.anchor(line);
  }

  toggleWrap(): void {
    const line = this.following ? undefined : this.firstVisibleLine();
    this.wrapping = !this.wrapping;
    this.rowsCache = undefined;
    if (line !== undefined) this.anchor(line);
  }

  get scrollHeight(): number {
    return Math.max(1, this.height);
  }

  pause(): void {
    this.offset = this.visibleOffset(this.rows().length);
    this.following = false;
  }

  resume(): void {
    this.offset = Number.POSITIVE_INFINITY;
    this.following = true;
  }

  scroll(delta: number): Navigation | undefined {
    const page = this.page;
    if (!page) return;
    const length = this.rows().length;
    const last = Math.max(0, length - this.scrollHeight);
    const current = this.visibleOffset(length);
    if (delta < 0) {
      this.pause();
      if (current === 0 && page.start > 0)
        return { anchor: { before: page.start }, atBottom: true };
      this.offset = Math.max(0, current + delta);
    } else if (current === last && page.end < page.size) {
      return { anchor: { after: page.end }, atBottom: false };
    } else if (current + delta >= last && page.end === page.size) {
      this.resume();
      return { atBottom: true };
    } else {
      this.offset = Math.min(last, current + delta);
    }
  }

  firstVisibleLine(): number {
    const rows = this.rows();
    return (
      rows[this.visibleOffset(rows.length)]?.line ?? this.page?.firstLine ?? 1
    );
  }

  visibleRows(): LogRow[] {
    const rows = this.rows();
    const start = this.visibleOffset(rows.length);
    const visible = rows.slice(start, start + this.scrollHeight);
    return this.wrapping
      ? visible
      : visible.map((row) => ({
          ...row,
          text: this.highlight(row.text, this.query),
        }));
  }

  private anchor(line: number): void {
    this.offset = Math.max(
      0,
      this.rows().findIndex((row) => row.line === line),
    );
  }

  private visibleOffset(length: number): number {
    return Math.min(this.offset, Math.max(0, length - this.scrollHeight));
  }

  private rows(): LogRow[] {
    const page = this.page;
    if (!page) return [];
    if (this.rowsCache?.page === page) return this.rowsCache.rows;
    const width = Math.max(1, this.width - String(page.totalLines).length - 2);
    const rows = page.lines.flatMap((text, i) => {
      const segments = this.wrapping
        ? wrapTextWithAnsi(this.highlight(text, this.query), width)
        : [text];
      return segments.map((segment, j) => ({
        line: page.firstLine + i,
        text: segment,
        continuation: j > 0,
      }));
    });
    this.rowsCache = { page, rows };
    return rows;
  }
}
