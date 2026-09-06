import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Type } from "typebox";
import { extractPDF, isPDF } from "./pdf.ts";
import { extractRSCContent } from "./rsc.ts";
import type { FetchResult } from "./types.ts";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 500;
const JS_RENDERED_ERROR =
  "Page appears to be JavaScript-rendered (content loads dynamically)";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// ── Response limits ──────────────────────────────────────────────────

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Response too large (limit: ${formatSize(maxBytes)})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isLikelyJSRendered(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return false;
  const textContent = bodyMatch[1]
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const scriptCount = (html.match(/<script/gi) || []).length;
  return textContent.length < 500 && scriptCount > 3;
}

function extractHeadingTitle(text: string): string | null {
  const match = text.match(/^#{1,2}\s+(.+)/m);
  if (!match) return null;
  const cleaned = match[1].replace(/\*+/g, "").trim();
  return cleaned || null;
}

// ── Main HTTP Extraction ─────────────────────────────────────────────

async function extractViaHttp(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);

  try {
    const response = await fetch(url, {
      signal: requestSignal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    if (!response.ok) {
      return {
        url,
        title: "",
        content: "",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const contentLengthHeader = response.headers.get("content-length");
    const isPDFContent = isPDF(url, contentType);
    const maxSize = isPDFContent ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE;

    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (contentLength > maxSize) {
        return {
          url,
          title: "",
          content: "",
          error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
        };
      }
    }

    if (isPDFContent) {
      const buffer = await readLimitedBody(response, maxSize);
      return { url, ...(await extractPDF(buffer, url)), error: null };
    }

    if (
      contentType.includes("application/octet-stream") ||
      contentType.includes("image/") ||
      contentType.includes("audio/") ||
      contentType.includes("video/") ||
      contentType.includes("application/zip")
    ) {
      return {
        url,
        title: "",
        content: "",
        error: `Unsupported content type: ${contentType.split(";")[0]}`,
      };
    }

    const text = new TextDecoder().decode(
      await readLimitedBody(response, maxSize),
    );
    const isHTML =
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml");

    if (!isHTML) {
      const title =
        extractHeadingTitle(text) ??
        new URL(url).pathname.split("/").pop() ??
        url;
      return { url, title, content: text, error: null };
    }

    const { document } = parseHTML(text);
    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();

    if (!article) {
      const rscResult = extractRSCContent(text);
      if (rscResult) {
        return {
          url,
          title: rscResult.title,
          content: rscResult.content,
          error: null,
        };
      }

      const jsRendered = isLikelyJSRendered(text);
      return {
        url,
        title: "",
        content: "",
        error: jsRendered
          ? JS_RENDERED_ERROR
          : "Could not extract readable content from HTML structure",
      };
    }

    const markdown = turndown.turndown(article.content);

    if (markdown.length < MIN_USEFUL_CONTENT) {
      return {
        url,
        title: article.title || "",
        content: markdown,
        error: isLikelyJSRendered(text)
          ? JS_RENDERED_ERROR
          : "Extracted content appears incomplete",
      };
    }

    return {
      url,
      title: article.title || "",
      content: markdown,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { url, title: "", content: "", error: message };
  }
}

// ── Public Fetch Function ────────────────────────────────────────────

export async function fetchAndExtract(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (signal?.aborted) {
    return { url, title: "", content: "", error: "Aborted" };
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        url,
        title: "",
        content: "",
        error: "URL must use HTTP or HTTPS",
      };
    }
  } catch {
    return { url, title: "", content: "", error: "Invalid URL" };
  }

  const result = await extractViaHttp(url, signal);
  if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };
  if (!result.error?.startsWith(JS_RENDERED_ERROR)) return result;

  // Only the requested URL is ever contacted, so a dynamic page has no
  // second chance here; point the model at alternatives instead.
  return {
    ...result,
    error: `${result.error}\n\nTry:\n  • A different URL for the same content\n  • web_search to find cached/alternative versions`,
  };
}

// ── Extension Registration ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch a web page and extract readable content as clean markdown. Handles PDFs and plain text. Only the requested URL is contacted; JavaScript-rendered pages fail with an explicit error. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet:
      "Fetch a URL and extract readable content as markdown. Supports HTML pages, PDFs, and plain text.",

    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),

    async execute(_toolCallId, params, signal) {
      const result = await fetchAndExtract(params.url, signal);

      if (result.error) {
        throw new Error(`${params.url}: ${result.error}`);
      }

      const header = result.title
        ? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
        : "";
      const output = truncateHead(header + result.content, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const notice = output.truncated
        ? `\n\n[Content truncated: showing ${output.outputLines} of ${output.totalLines} lines (${formatSize(output.outputBytes)} of ${formatSize(output.totalBytes)}).]`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: output.content + notice,
          },
        ],
        details: {
          url: result.url,
          title: result.title,
          chars: result.content.length,
          truncated: output.truncated,
        },
      };
    },

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const { url } = args as { url?: string };
      if (!url) {
        text.setText(
          theme.fg("toolTitle", theme.bold("fetch ")) +
            theme.fg("error", "(no URL)"),
        );
        return text;
      }
      const display = url.length > 70 ? `${url.slice(0, 67)}...` : url;
      text.setText(
        theme.fg("toolTitle", theme.bold("fetch ")) +
          theme.fg("accent", display),
      );
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      if (isPartial) {
        text.setText(theme.fg("warning", "Fetching…"));
        return text;
      }

      if (context.isError) {
        const msg =
          result.content.find((c) => c.type === "text")?.text || "Error";
        text.setText(theme.fg("error", msg));
        return text;
      }

      const details = result.details as {
        title?: string;
        chars?: number;
      };

      const title = details?.title || "Untitled";
      const chars = details?.chars ?? 0;
      const status =
        theme.fg("success", title) + theme.fg("muted", ` (${chars} chars)`);

      if (!expanded) {
        text.setText(status);
        return text;
      }

      const content = result.content.find((c) => c.type === "text")?.text || "";
      const preview =
        content.length > 500 ? `${content.slice(0, 500)}...` : content;
      text.setText(`${status}\n${theme.fg("dim", preview)}`);
      return text;
    },
  });
}
