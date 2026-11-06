/** `/files` and alt+o append selected Git or local files to the current draft. */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { discoverFiles } from "./discovery.ts";
import { showFilePicker } from "./picker.ts";

const runFileBrowser = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> => {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Files requires interactive mode", "error");
    return;
  }
  try {
    const files = await discoverFiles(pi, ctx.cwd);
    if (!files.length) {
      ctx.ui.notify("No files found", "info");
      return;
    }
    const selected = await showFilePicker(ctx, files);
    if (!selected?.length) return;
    const mentions = selected.map((file) => `@${file.displayPath}`).join(" ");
    const current = ctx.ui.getEditorText();
    const separator = current && !/\s$/.test(current) ? " " : "";
    ctx.ui.setEditorText(`${current}${separator}${mentions}`);
    ctx.ui.notify(
      `Added ${selected.length} file mention${selected.length === 1 ? "" : "s"} to prompt`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not load files: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
};

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("files", {
    description: "Select Git or local files for the prompt",
    handler: async (_args, ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });
  pi.registerShortcut("alt+o", {
    description: "Select Git or local files for the prompt",
    handler: async (ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });
}
