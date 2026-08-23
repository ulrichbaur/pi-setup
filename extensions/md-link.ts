import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "md-link";
const STATUS_KEY = "md-link";
const RESPONSE_SEPARATOR = "\n\n---\n---\n";

interface LinkState {
  file: string | null;
}

/** Resolve a linked file relative to the current working directory. */
export function linkedMarkdownPath(cwd: string, filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) throw new Error("Usage: /link-md <filepath>");
  return path.resolve(cwd, trimmed);
}

/** Convert a saved file change into the next user message. */
export function markdownChangeMessage(
  previous: string,
  current: string,
): string | null {
  if (previous === current) return null;

  if (current.startsWith(previous)) {
    return current.slice(previous.length).trim() || null;
  }

  const oldLines = previous.split("\n");
  const newLines = current.split("\n");

  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (
    oldEnd >= start &&
    newEnd >= start &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const removed = oldLines.slice(start, oldEnd + 1);
  const added = newLines.slice(start, newEnd + 1);
  if (removed.length === 0 && added.length === 0) return null;
  if (removed.length === 0) return added.join("\n").trim() || null;

  const parts: string[] = [];
  if (start > 0) {
    const context = oldLines[start - 1].trim().slice(0, 100);
    if (context) parts.push(`[After: "${context}"]`);
  }
  parts.push(`Removed:\n${removed.join("\n")}`);
  if (added.length > 0) parts.push(`Replaced with:\n${added.join("\n")}`);
  return parts.join("\n\n").trim() || null;
}

/** Return final assistant text, excluding messages that still call tools. */
export function finalAssistantMarkdown(
  message: AssistantMessage,
): string | null {
  if (message.content.some((block) => block.type === "toolCall")) return null;

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return text || null;
}

export default function markdownLinkExtension(pi: ExtensionAPI): void {
  let linkedFile: string | null = null;
  let lastKnownContent = "";

  function clearLink(ctx: ExtensionContext): void {
    linkedFile = null;
    lastKnownContent = "";
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function showLink(ctx: ExtensionContext, filename: string): void {
    ctx.ui.setStatus(STATUS_KEY, `📄 ${path.basename(filename)}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    clearLink(ctx);

    let savedFile: string | null = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const state = entry.data as LinkState | undefined;
      savedFile = typeof state?.file === "string" ? state.file : null;
    }

    if (!savedFile) return;
    try {
      lastKnownContent = await readFile(savedFile, "utf8");
      linkedFile = savedFile;
      showLink(ctx, savedFile);
    } catch {
      clearLink(ctx);
    }
  });

  pi.registerCommand("link-md", {
    description: "Link a Markdown file for collaborative editing",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const target = linkedMarkdownPath(ctx.cwd, args);
        await withFileMutationQueue(target, async () => {
          await mkdir(path.dirname(target), { recursive: true });
          try {
            lastKnownContent = await readFile(target, "utf8");
          } catch (error) {
            if (!isMissingFile(error)) throw error;
            await writeFile(target, "", "utf8");
            lastKnownContent = "";
          }
        });

        linkedFile = target;
        pi.appendEntry(STATE_TYPE, { file: target } satisfies LinkState);
        showLink(ctx, target);
        ctx.ui.notify(`Linked Markdown file: ${target}`, "info");
      } catch (error) {
        ctx.ui.notify(
          errorMessage("Could not link Markdown file", error),
          "error",
        );
      }
    },
  });

  pi.registerCommand("unlink-md", {
    description: "Unlink the current Markdown file",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (!linkedFile) {
        ctx.ui.notify("No Markdown file is linked", "warning");
        return;
      }

      const name = path.basename(linkedFile);
      clearLink(ctx);
      pi.appendEntry(STATE_TYPE, { file: null } satisfies LinkState);
      ctx.ui.notify(`Unlinked Markdown file: ${name}`, "info");
    },
  });

  const sendDiff = async (
    _args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    if (!linkedFile) {
      ctx.ui.notify(
        "No Markdown file is linked. Use /link-md first.",
        "warning",
      );
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify(
        "Wait for the agent to finish before sending file changes",
        "warning",
      );
      return;
    }

    const target = linkedFile;
    try {
      const current = await readFile(target, "utf8");
      const message = markdownChangeMessage(lastKnownContent, current);
      if (!message) {
        ctx.ui.notify("No Markdown changes detected", "info");
        return;
      }

      pi.sendUserMessage(message);
      if (linkedFile === target) lastKnownContent = current;
    } catch (error) {
      ctx.ui.notify(
        errorMessage("Could not send Markdown changes", error),
        "error",
      );
    }
  };

  pi.registerCommand("send-diff", {
    description: "Send linked Markdown edits as a user message",
    handler: sendDiff,
  });

  pi.registerCommand("sd", {
    description: "Alias for /send-diff",
    handler: sendDiff,
  });

  pi.on("message_end", async (event) => {
    if (!linkedFile || event.message.role !== "assistant") return;
    const text = finalAssistantMarkdown(event.message);
    if (!text) return;

    const target = linkedFile;
    try {
      const updated = await withFileMutationQueue(target, async () => {
        const current = await readFile(target, "utf8");
        const prefix = appendPrefix(current);
        const next = `${current}${prefix}${text}${RESPONSE_SEPARATOR}`;
        await writeFile(target, next, "utf8");
        return next;
      });
      if (linkedFile === target) lastKnownContent = updated;
    } catch {
      // The linked file may have been removed or become unwritable.
    }
  });
}

function appendPrefix(content: string): string {
  if (content.trim().length === 0 || content.endsWith("\n\n")) return "";
  return content.endsWith("\n") ? "\n" : "\n\n";
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorMessage(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`;
}
