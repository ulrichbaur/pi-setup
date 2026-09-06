import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyText, VERSION } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Build the compact two-line startup header. */
export function cleanHeaderText(theme: Theme): string {
  const hint = (key: string, label: string): string =>
    theme.fg("dim", key) + theme.fg("muted", ` ${label}`);

  const logo = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
  const shortcuts = [
    hint(keyText("app.interrupt"), "interrupt"),
    hint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
    hint("/", "commands"),
    hint("!", "bash"),
    hint(keyText("app.tools.expand"), "more"),
  ].join(theme.fg("muted", " · "));

  return `\n ${logo}\n ${shortcuts}`;
}

export default function cleanHeaderExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => new Text(cleanHeaderText(theme), 0, 0));
  });
}
