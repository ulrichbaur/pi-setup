/**
 * Utility functions for the files extension.
 * Extracted so they can be unit-tested without pi runtime dependencies.
 */

import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentBlock = {
  type?: string;
  text?: string;
  arguments?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Regex patterns for file-reference extraction
// ---------------------------------------------------------------------------

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

// ---------------------------------------------------------------------------
// File-reference extraction
// ---------------------------------------------------------------------------

/**
 * Extract file references from plain text.  Recognises:
 * - <file name="..."> XML tags
 * - file:// URIs
 * - Absolute paths (starting with ~ or /) that appear in typical prose positions.
 */
export function extractFileReferencesFromText(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(FILE_TAG_REGEX)) refs.push(match[1]);
  for (const match of text.matchAll(FILE_URL_REGEX)) refs.push(match[0]);
  for (const match of text.matchAll(PATH_REGEX)) refs.push(match[1]);
  return refs;
}

/** Pull candidate file paths from a tool-call arguments object. */
export function extractPathsFromToolArgs(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const refs: string[] = [];
  const record = args as Record<string, unknown>;
  const directKeys = [
    "path",
    "file",
    "filePath",
    "filepath",
    "fileName",
    "filename",
  ] as const;
  const listKeys = ["paths", "files", "filePaths"] as const;
  for (const key of directKeys) {
    if (typeof record[key] === "string") refs.push(record[key]);
  }
  for (const key of listKeys) {
    if (Array.isArray(record[key])) {
      for (const item of record[key]) {
        if (typeof item === "string") refs.push(item);
      }
    }
  }
  return refs;
}

/**
 * Extract file references from an LLM content block (string or array of
 * text/toolCall parts).
 */
export function extractFileReferencesFromContent(content: unknown): string[] {
  if (typeof content === "string")
    return extractFileReferencesFromText(content);
  if (!Array.isArray(content)) return [];
  const refs: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      refs.push(...extractFileReferencesFromText(block.text));
    }
    if (block.type === "toolCall") {
      refs.push(...extractPathsFromToolArgs(block.arguments));
    }
  }
  return refs;
}

/**
 * Extract file references from a session entry (message or custom_message).
 */
export function extractFileReferencesFromEntry(entry: {
  type?: string;
  message?: unknown;
  content?: unknown;
}): string[] {
  if (entry.type === "message") {
    const message = entry.message;
    if (message && typeof message === "object" && "content" in message) {
      return extractFileReferencesFromContent(
        (message as { content?: unknown }).content,
      );
    }
    return [];
  }
  if (entry.type === "custom_message") {
    return extractFileReferencesFromContent(entry.content);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Path normalisation helpers
// ---------------------------------------------------------------------------

/** Strip surrounding quotes, brackets, and trailing punctuation. */
export function sanitizeReference(raw: string): string {
  let value = raw.trim();
  value = value
    .replace(/^["'`(<[]+/, "")
    .replace(/[>"'`,;).\]]+$/, "")
    .replace(/[.,;:]+$/, "");
  return value;
}

/**
 * Remove GitHub-style line-number suffixes (#L42, #L10C5) and vim-style
 * colon-suffixes (path:42, path:10:5).
 */
export function stripLineSuffix(value: string): string {
  const result = value.replace(/#L\d+(C\d+)?$/i, "");
  const lastSeparator = Math.max(
    result.lastIndexOf("/"),
    result.lastIndexOf("\\"),
  );
  const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
  return (
    result.slice(0, segmentStart) +
    result.slice(segmentStart).replace(/:\d+(:\d+)?$/, "")
  );
}

/**
 * Normalise a raw file reference into an absolute path.
 * Returns null if the reference is not a meaningful path.
 */
export function normalizeReferencePath(
  raw: string,
  cwd: string,
): string | null {
  let candidate = sanitizeReference(raw);
  if (!candidate || candidate.startsWith("//")) return null;
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  candidate = stripLineSuffix(candidate);
  if (!candidate || candidate.startsWith("//")) return null;
  if (candidate.startsWith("~"))
    candidate = path.join(os.homedir(), candidate.slice(1));
  if (!path.isAbsolute(candidate)) candidate = path.resolve(cwd, candidate);
  candidate = path.normalize(candidate);
  const root = path.parse(candidate).root;
  if (candidate.length > root.length)
    candidate = candidate.replace(/[\\/]+$/, "");
  return candidate;
}

/**
 * Format an absolute path for display.  Paths under `cwd` are shown relative;
 * everything else is shown as an absolute path.
 */
export function formatDisplayPath(absolutePath: string, cwd: string): string {
  const normalizedCwd = path.resolve(cwd);
  if (absolutePath.startsWith(normalizedCwd + path.sep))
    return path.relative(normalizedCwd, absolutePath);
  return absolutePath;
}

// ---------------------------------------------------------------------------
// Session file changes
// ---------------------------------------------------------------------------

export type SessionFileChange = {
  lastTimestamp: number;
};

/**
 * Collect files mutated during the session via successful write/edit tool
 * calls, keyed by canonical path. Failed tool results are ignored — no
 * mutation happened.
 */
export function collectSessionFileChanges(
  entries: SessionEntry[],
  cwd: string,
): Map<string, SessionFileChange> {
  const toolCallPaths = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block.type === "toolCall" &&
          (block.name === "write" || block.name === "edit")
        ) {
          const filePath = block.arguments?.path;
          if (filePath && typeof filePath === "string")
            toolCallPaths.set(block.id, filePath);
        }
      }
    }
  }
  const fileMap = new Map<string, SessionFileChange>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role === "toolResult") {
      if (msg.isError) continue;
      const filePath = toolCallPaths.get(msg.toolCallId);
      if (!filePath) continue;
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(cwd, filePath);
      const canonical = toCanonicalPath(resolvedPath);
      if (!canonical.exists) continue;
      const existing = fileMap.get(canonical.canonicalPath);
      if (!existing || msg.timestamp > existing.lastTimestamp)
        fileMap.set(canonical.canonicalPath, { lastTimestamp: msg.timestamp });
    }
  }
  return fileMap;
}

// ---------------------------------------------------------------------------
// Canonical paths
// ---------------------------------------------------------------------------

/**
 * Resolve a path lexically (no symlink resolution, so a tracked symlink keeps
 * its own path as identity). `exists` is false when the path is missing
 * (e.g. deletions in git status).
 */
export function toCanonicalPath(inputPath: string): {
  canonicalPath: string;
  isDirectory: boolean;
  exists: boolean;
} {
  const canonicalPath = path.resolve(inputPath);
  try {
    return {
      canonicalPath,
      isDirectory: statSync(canonicalPath).isDirectory(),
      exists: true,
    };
  } catch {
    return { canonicalPath, isDirectory: false, exists: false };
  }
}

// ---------------------------------------------------------------------------
// Git status parsing
// ---------------------------------------------------------------------------

export type GitStatusRecord = {
  status: string;
  path: string;
  origPath?: string;
};

/**
 * Parse `git status --porcelain=1 -z` output. Records are `XY <path>`,
 * NUL-separated; rename/copy records carry one extra NUL-separated field
 * holding the ORIGINAL path — in the -z format the destination comes first,
 * unlike the human-readable `old -> new`.
 */
export function parseGitStatusOutput(stdout: string): GitStatusRecord[] {
  const fields = stdout.split("\0").filter(Boolean);
  const records: GitStatusRecord[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const filePath = field.slice(3);
    if (!filePath) continue;
    const record: GitStatusRecord = { status, path: filePath };
    if (/[RC]/.test(status) && fields[i + 1]) {
      record.origPath = fields[i + 1];
      i += 1;
    }
    records.push(record);
  }
  return records;
}
