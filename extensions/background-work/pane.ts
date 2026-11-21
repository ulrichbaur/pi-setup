/** What a detail pane shows. The surrounding view draws the frame. */
export interface PaneView {
  /** The header and body, top to bottom. */
  lines: string[];
  /** The key hints, shown last. */
  hint: string;
  /** Shown above the hints. */
  notice?: { text: string; error: boolean };
}

/** The detail view of one job or run, inside a view that owns the frame. */
export interface DetailPane {
  /** `height` counts the rows for lines, the notice, and the hints. */
  render(width: number, height: number): PaneView;
  /** "back" asks the surrounding view to leave the pane. */
  handleInput(data: string): "back" | "handled";
  dispose(): void;
}
