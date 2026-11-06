/**
 * `/files` and alt+o: one fuzzy-searchable list over the Git tree
 * and the files mentioned or changed in the session. Confirming a selection
 * appends the selected files as `@path` mentions to the existing prompt.
 */

import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { showFilePicker } from "./picker.ts";
import {
  collectSessionFileChanges,
  extractFileReferencesFromEntry,
  formatDisplayPath,
  normalizeReferencePath,
  parseGitStatusOutput,
  toCanonicalPath,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FileEntry = {
  canonicalPath: string;
  displayPath: string;
  isDirectory: boolean;
  status?: string;
  inRepo: boolean;
  isReferenced: boolean;
  hasSessionChange: boolean;
  lastTimestamp: number;
};

/** Most recent session file references first, deduplicated, as normalized absolute paths. */
const collectRecentFileReferences = (
  entries: SessionEntry[],
  cwd: string,
  limit: number,
): string[] => {
  const results: string[] = [];
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
    const refs = extractFileReferencesFromEntry(entries[i]);
    for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
      const normalized = normalizeReferencePath(refs[j], cwd);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      results.push(normalized);
    }
  }
  return results;
};

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const getGitRoot = async (
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | null> => {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.code === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : null;
};

type GitStatusEntry = {
  status: string;
  isDirectory: boolean;
};

const getGitStatusMap = async (
  pi: ExtensionAPI,
  cwd: string,
): Promise<Map<string, GitStatusEntry>> => {
  const statusMap = new Map<string, GitStatusEntry>();
  const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], {
    cwd,
  });
  if (statusResult.code !== 0 || !statusResult.stdout) return statusMap;
  for (const record of parseGitStatusOutput(statusResult.stdout)) {
    const statusLabel =
      record.status.replace(/\s/g, "") || record.status.trim();
    const resolved = path.isAbsolute(record.path)
      ? record.path
      : path.resolve(cwd, record.path);
    const canonical = toCanonicalPath(resolved);
    statusMap.set(canonical.canonicalPath, {
      status: statusLabel,
      isDirectory: canonical.isDirectory,
    });
  }
  return statusMap;
};

const getGitFiles = async (
  pi: ExtensionAPI,
  gitRoot: string,
): Promise<Array<{ canonicalPath: string; isDirectory: boolean }>> => {
  const files: Array<{ canonicalPath: string; isDirectory: boolean }> = [];
  const result = await pi.exec(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: gitRoot },
  );
  if (result.code !== 0 || !result.stdout) return files;
  for (const relativePath of result.stdout.split("\0").filter(Boolean)) {
    const canonical = toCanonicalPath(path.resolve(gitRoot, relativePath));
    if (canonical.exists) files.push(canonical);
  }
  return files;
};

const isInRepo = (gitRoot: string | null, canonicalPath: string): boolean => {
  if (!gitRoot) return false;
  const relative = path.relative(gitRoot, canonicalPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

// ---------------------------------------------------------------------------
// Build unified file list
// ---------------------------------------------------------------------------

const buildFileEntries = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<{ files: FileEntry[]; gitRoot: string | null }> => {
  const entries = ctx.sessionManager.getBranch();
  const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
  const gitRoot = await getGitRoot(pi, ctx.cwd);
  const statusMap = gitRoot
    ? await getGitStatusMap(pi, gitRoot)
    : new Map<string, GitStatusEntry>();
  const gitFiles = gitRoot ? await getGitFiles(pi, gitRoot) : [];
  const fileMap = new Map<string, FileEntry>();
  const upsertFile = (
    data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean },
  ) => {
    const existing = fileMap.get(data.canonicalPath);
    if (existing) {
      fileMap.set(data.canonicalPath, {
        ...existing,
        ...data,
        isReferenced: existing.isReferenced || data.isReferenced === true,
        inRepo: existing.inRepo || data.inRepo === true,
        hasSessionChange:
          existing.hasSessionChange || data.hasSessionChange === true,
        lastTimestamp: Math.max(
          existing.lastTimestamp,
          data.lastTimestamp ?? 0,
        ),
      });
      return;
    }
    fileMap.set(data.canonicalPath, {
      canonicalPath: data.canonicalPath,
      displayPath: formatDisplayPath(data.canonicalPath, ctx.cwd),
      isDirectory: data.isDirectory,
      status: data.status,
      inRepo: data.inRepo ?? false,
      isReferenced: data.isReferenced ?? false,
      hasSessionChange: data.hasSessionChange ?? false,
      lastTimestamp: data.lastTimestamp ?? 0,
    });
  };
  for (const file of gitFiles) {
    upsertFile({
      canonicalPath: file.canonicalPath,
      isDirectory: file.isDirectory,
      status: statusMap.get(file.canonicalPath)?.status,
      inRepo: true,
    });
  }
  for (const [canonicalPath, statusEntry] of statusMap.entries()) {
    if (fileMap.has(canonicalPath)) continue;
    upsertFile({
      canonicalPath,
      isDirectory: statusEntry.isDirectory,
      status: statusEntry.status,
      inRepo: isInRepo(gitRoot, canonicalPath),
    });
  }
  for (const referencePath of collectRecentFileReferences(
    entries,
    ctx.cwd,
    200,
  )) {
    const canonical = toCanonicalPath(referencePath);
    if (!canonical.exists) continue;
    upsertFile({
      canonicalPath: canonical.canonicalPath,
      isDirectory: canonical.isDirectory,
      status: statusMap.get(canonical.canonicalPath)?.status,
      inRepo: isInRepo(gitRoot, canonical.canonicalPath),
      isReferenced: true,
    });
  }
  for (const [canonicalPath, change] of sessionChanges.entries()) {
    const canonical = toCanonicalPath(canonicalPath);
    if (!canonical.exists) continue;
    upsertFile({
      canonicalPath: canonical.canonicalPath,
      isDirectory: canonical.isDirectory,
      status: statusMap.get(canonical.canonicalPath)?.status,
      inRepo: isInRepo(gitRoot, canonical.canonicalPath),
      hasSessionChange: true,
      lastTimestamp: change.lastTimestamp,
    });
  }
  const files = Array.from(fileMap.values()).sort((a, b) => {
    const aDirty = Boolean(a.status),
      bDirty = Boolean(b.status);
    if (aDirty !== bDirty) return aDirty ? -1 : 1;
    if (a.inRepo !== b.inRepo) return a.inRepo ? -1 : 1;
    if (a.hasSessionChange !== b.hasSessionChange)
      return a.hasSessionChange ? -1 : 1;
    if (a.lastTimestamp !== b.lastTimestamp)
      return b.lastTimestamp - a.lastTimestamp;
    if (a.isReferenced !== b.isReferenced) return a.isReferenced ? -1 : 1;
    return a.displayPath.localeCompare(b.displayPath);
  });
  return { files, gitRoot };
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const addFilesToPrompt = (
  ctx: ExtensionContext,
  selected: readonly { displayPath: string }[],
): void => {
  const mentions = selected.map((file) => `@${file.displayPath}`).join(" ");
  const current = ctx.ui.getEditorText();
  const separator = current && !/\s$/.test(current) ? " " : "";
  ctx.ui.setEditorText(`${current}${separator}${mentions}`);
  ctx.ui.notify(
    `Added ${selected.length} file mention${selected.length === 1 ? "" : "s"} to prompt`,
    "info",
  );
};

// ---------------------------------------------------------------------------
// Main file browser flow
// ---------------------------------------------------------------------------

const runFileBrowser = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> => {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Files requires interactive mode", "error");
    return;
  }

  const { files } = await buildFileEntries(pi, ctx);
  if (files.length === 0) {
    ctx.ui.notify("No files found", "info");
    return;
  }

  const selected = await showFilePicker(ctx, files);
  if (selected?.length) addFilesToPrompt(ctx, selected);
};

// ---------------------------------------------------------------------------
// Extension export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("files", {
    description: "Browse files with git status",
    handler: async (_args, ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });

  pi.registerShortcut("alt+o", {
    description: "Browse files mentioned or changed in the session",
    handler: async (ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });
}
