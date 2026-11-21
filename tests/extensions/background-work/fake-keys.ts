import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

export const KEYS = {
  escape: "\x1b",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
};

const BINDINGS: Record<string, string> = {
  "tui.select.cancel": KEYS.escape,
  "tui.select.confirm": KEYS.enter,
  "tui.select.up": KEYS.up,
  "tui.select.down": KEYS.down,
  "tui.select.pageUp": KEYS.pageUp,
  "tui.select.pageDown": KEYS.pageDown,
};

/** Pi's default bindings for the keys the views use. */
export const keys = {
  matches: (data: string, id: string) => BINDINGS[id] === data,
} as unknown as KeybindingsManager;
