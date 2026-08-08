import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Return the Markdown text from an assistant message entry. */
export function assistantMarkdown(entry: SessionEntry): string | null {
  if (entry.type !== "message" || entry.message.role !== "assistant") {
    return null;
  }

  const { content } = entry.message;
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  return text || null;
}

/** Find the latest assistant message with textual content on the active branch. */
export function latestAssistantMarkdown(
  entries: SessionEntry[],
): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const markdown = assistantMarkdown(entries[i]);
    if (markdown !== null) return markdown;
  }
  return null;
}

/** Resolve a Markdown target relative to cwd unless name is absolute. */
export function markdownTarget(cwd: string, name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("Usage: /save-md name");

  const filename = trimmedName.toLowerCase().endsWith(".md")
    ? trimmedName
    : `${trimmedName}.md`;
  return path.resolve(cwd, filename);
}

async function saveMarkdown(
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    await ctx.waitForIdle();
    const target = markdownTarget(ctx.cwd, name);
    const markdown = latestAssistantMarkdown(ctx.sessionManager.getBranch());
    if (markdown === null) {
      throw new Error("No assistant message with Markdown text was found");
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      markdown.endsWith("\n") ? markdown : `${markdown}\n`,
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    ctx.ui.notify(
      `Saved Markdown to ${path.relative(ctx.cwd, target)}`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not save Markdown: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("save-md", {
    description: "Save the last assistant message as Markdown",
    handler: async (args, ctx) => {
      await saveMarkdown(args, ctx);
    },
  });
}
