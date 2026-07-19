/**
 * Files Extension (simplified)
 *
 * /files command lists files in the current git tree (plus session-referenced files)
 * and offers quick actions: add to prompt or copy path.
 */

import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  copyToClipboard,
  DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  collectSessionFileChanges,
  extractFileReferencesFromEntry,
  formatDisplayPath,
  normalizeReferencePath,
  parseGitStatusOutput,
  toCanonicalPath,
} from "./utils.js";

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
  const listings = [
    ["ls-files", "-z"],
    ["ls-files", "-z", "--others", "--exclude-standard"],
  ];
  for (const args of listings) {
    const result = await pi.exec("git", args, { cwd: gitRoot });
    if (result.code !== 0 || !result.stdout) continue;
    for (const relativePath of result.stdout.split("\0").filter(Boolean)) {
      const canonical = toCanonicalPath(path.resolve(gitRoot, relativePath));
      if (canonical.exists) files.push(canonical);
    }
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

const addFileToPrompt = (ctx: ExtensionContext, target: FileEntry): void => {
  const mention = `@${target.displayPath}`;
  const current = ctx.ui.getEditorText();
  const separator = current && !current.endsWith(" ") ? " " : "";
  ctx.ui.setEditorText(`${current}${separator}${mention}`);
  ctx.ui.notify(`Added ${mention} to prompt`, "info");
};

const copyPathToClipboard = (
  ctx: ExtensionContext,
  target: FileEntry,
): void => {
  copyToClipboard(target.canonicalPath);
  ctx.ui.notify(`Copied ${target.displayPath} to clipboard`, "info");
};

// ---------------------------------------------------------------------------
// File selector TUI
// ---------------------------------------------------------------------------

const showFileSelector = async (
  ctx: ExtensionContext,
  files: FileEntry[],
  selectedPath?: string | null,
): Promise<FileEntry | null> => {
  const items: SelectItem[] = files.map((file) => {
    const directoryLabel = file.isDirectory ? " [directory]" : "";
    const statusSuffix = file.status ? ` [${file.status}]` : "";
    return {
      value: file.canonicalPath,
      label: `${file.displayPath}${directoryLabel}${statusSuffix}`,
    };
  });
  const selection = await ctx.ui.custom<string | null>(
    (tui, theme, keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold(" Select file")), 0, 0),
      );
      const searchInput = new Input();
      container.addChild(searchInput);
      container.addChild(new Spacer(1));
      const listContainer = new Container();
      container.addChild(listContainer);
      container.addChild(
        new Text(
          theme.fg("dim", "Type to filter • enter to select • esc to cancel"),
          0,
          0,
        ),
      );
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      let filteredItems = items;
      let selectList: SelectList | null = null;
      const updateList = () => {
        listContainer.clear();
        if (filteredItems.length === 0) {
          listContainer.addChild(
            new Text(theme.fg("warning", "  No matching files"), 0, 0),
          );
          selectList = null;
          return;
        }
        selectList = new SelectList(
          filteredItems,
          Math.min(filteredItems.length, 12),
          {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        );
        if (selectedPath) {
          const index = filteredItems.findIndex(
            (item) => item.value === selectedPath,
          );
          if (index >= 0) selectList.setSelectedIndex(index);
        }
        selectList.onSelect = (item) => done(item.value as string);
        selectList.onCancel = () => done(null);
        listContainer.addChild(selectList);
      };
      const applyFilter = () => {
        const query = searchInput.getValue();
        filteredItems = query
          ? fuzzyFilter(
              items,
              query,
              (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
            )
          : items;
        updateList();
      };
      applyFilter();
      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down") ||
            keybindings.matches(data, "tui.select.confirm") ||
            keybindings.matches(data, "tui.select.cancel")
          ) {
            if (selectList) selectList.handleInput(data);
            else if (keybindings.matches(data, "tui.select.cancel")) done(null);
            tui.requestRender();
            return;
          }
          searchInput.handleInput(data);
          applyFilter();
          tui.requestRender();
        },
      };
    },
  );
  return selection
    ? (files.find((file) => file.canonicalPath === selection) ?? null)
    : null;
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
  let lastSelectedPath: string | null = null;
  while (true) {
    const selected = await showFileSelector(ctx, files, lastSelectedPath);
    if (!selected) return;

    lastSelectedPath = selected.canonicalPath;

    const action = await ctx.ui.select(`Actions for ${selected.displayPath}`, [
      "Add to prompt",
      "Copy path",
    ]);
    if (!action) continue;

    if (action === "Add to prompt") addFileToPrompt(ctx, selected);
    else if (action === "Copy path") copyPathToClipboard(ctx, selected);
  }
};

// ---------------------------------------------------------------------------
// Extension export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("files", {
    description: "Browse files with git status and session references",
    handler: async (_args, ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });

  pi.registerShortcut("ctrl+shift+o", {
    description: "Browse files mentioned in the session",
    handler: async (ctx) => {
      await runFileBrowser(pi, ctx);
    },
  });
}
