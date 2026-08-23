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
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  DynamicBorder,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  Key,
  Markdown,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  type FileChangeTracker,
  type RevertChangesResult,
  registerFileChangeTracking,
  type TrackedFileChange,
} from "./changes.js";
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
  piChange?: TrackedFileChange;
};

const ACCEPT_ALL = "__files_accept_all_pi_changes__";
const REVERT_ALL = "__files_revert_all_pi_changes__";

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
  changeTracker: FileChangeTracker,
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
      piChange: data.piChange,
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
  for (const change of changeTracker.list()) {
    const canonical = toCanonicalPath(change.absolutePath);
    upsertFile({
      canonicalPath: canonical.canonicalPath,
      isDirectory: canonical.isDirectory,
      status: statusMap.get(canonical.canonicalPath)?.status,
      inRepo: isInRepo(gitRoot, canonical.canonicalPath),
      hasSessionChange: true,
      lastTimestamp: change.updatedAt,
      piChange: change,
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
  trackedCount: number,
  selectedPath?: string | null,
): Promise<string | null> => {
  const items: SelectItem[] = [
    ...(trackedCount > 0
      ? [
          {
            value: ACCEPT_ALL,
            label: `Accept all Pi changes (${trackedCount})`,
            description: "Keep files and clear rollback snapshots",
          },
          {
            value: REVERT_ALL,
            label: `Revert all safe Pi changes (${trackedCount})`,
            description: "Skip files with external edits",
          },
        ]
      : []),
    ...files.map((file) => {
      const directoryLabel = file.isDirectory ? " [directory]" : "";
      const statusSuffix = file.status ? ` [${file.status}]` : "";
      const changeSuffix = file.piChange
        ? ` [Pi +${file.piChange.added}/-${file.piChange.removed}${file.piChange.conflict ? ", conflict" : ""}]`
        : "";
      return {
        value: file.canonicalPath,
        label: `${file.displayPath}${directoryLabel}${statusSuffix}${changeSuffix}`,
      };
    }),
  ];
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
  return selection;
};

const showChangeDiff = async (
  ctx: ExtensionContext,
  change: TrackedFileChange,
): Promise<void> => {
  const truncated = truncateHead(change.diff, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const conflict = change.conflict
    ? "\n\n> External edits detected. Safe revert is disabled for this file."
    : "";
  const truncation = truncated.truncated
    ? "\n\n> Diff truncated to Pi's standard output limits."
    : "";
  const markdown = `\`\`\`diff\n${truncated.content.trimEnd()}\n\`\`\`${conflict}${truncation}`;

  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold(change.displayPath)), 1, 0),
      );
      container.addChild(new Markdown(markdown, 1, 0, getMarkdownTheme()));
      container.addChild(
        new Text(theme.fg("dim", "Escape, q, or Enter to close"), 1, 0),
      );
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.ctrl("c")) ||
            data === "q"
          ) {
            done(undefined);
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "85%",
        minWidth: 48,
        maxHeight: "90%",
      },
    },
  );
};

const notifyRevertResult = (
  ctx: ExtensionContext,
  result: RevertChangesResult,
): void => {
  const parts: string[] = [];
  if (result.reverted.length > 0) {
    parts.push(`reverted ${result.reverted.length}`);
  }
  if (result.conflicts.length > 0) {
    parts.push(`skipped ${result.conflicts.length} conflict(s)`);
  }
  if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);
  ctx.ui.notify(
    parts.length > 0
      ? `Pi changes: ${parts.join(", ")}`
      : "No Pi changes to revert",
    result.conflicts.length > 0 || result.errors.length > 0
      ? "warning"
      : "info",
  );
};

// ---------------------------------------------------------------------------
// Main file browser flow
// ---------------------------------------------------------------------------

const runFileBrowser = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  changeTracker: FileChangeTracker,
): Promise<void> => {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Files requires interactive mode", "error");
    return;
  }

  let lastSelectedPath: string | null = null;
  while (true) {
    await changeTracker.refresh(ctx);
    const { files } = await buildFileEntries(pi, ctx, changeTracker);
    const trackedCount = changeTracker.list().length;
    if (files.length === 0 && trackedCount === 0) {
      ctx.ui.notify("No files found", "info");
      return;
    }

    const selection = await showFileSelector(
      ctx,
      files,
      trackedCount,
      lastSelectedPath,
    );
    if (!selection) return;

    if (selection === ACCEPT_ALL) {
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for Pi to finish before accepting changes",
          "warning",
        );
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        "Accept all Pi changes?",
        "This keeps the current files and clears all rollback snapshots.",
      );
      if (!confirmed) continue;
      const count = changeTracker.acceptAll();
      ctx.ui.notify(`Accepted Pi changes for ${count} file(s)`, "info");
      lastSelectedPath = null;
      continue;
    }

    if (selection === REVERT_ALL) {
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for Pi to finish before reverting changes",
          "warning",
        );
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        "Revert all safe Pi changes?",
        "Files with external edits will be skipped.",
      );
      if (!confirmed) continue;
      notifyRevertResult(ctx, await changeTracker.revertAll());
      lastSelectedPath = null;
      continue;
    }

    const selected = files.find((file) => file.canonicalPath === selection);
    if (!selected) continue;
    lastSelectedPath = selected.canonicalPath;

    const actions = ["Add to prompt", "Copy path"];
    if (selected.piChange) {
      actions.push("View Pi diff", "Accept Pi changes for this file");
      if (!selected.piChange.conflict) {
        actions.push("Revert Pi changes for this file");
      }
    }
    const action = await ctx.ui.select(
      `Actions for ${selected.displayPath}`,
      actions,
    );
    if (!action) continue;

    if (action === "Add to prompt") {
      addFileToPrompt(ctx, selected);
    } else if (action === "Copy path") {
      copyPathToClipboard(ctx, selected);
    } else if (action === "View Pi diff" && selected.piChange) {
      await showChangeDiff(ctx, selected.piChange);
    } else if (action === "Accept Pi changes for this file") {
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for Pi to finish before accepting changes",
          "warning",
        );
      } else if (changeTracker.acceptFile(selected.canonicalPath)) {
        ctx.ui.notify(
          `Accepted Pi changes for ${selected.displayPath}`,
          "info",
        );
      }
    } else if (
      action === "Revert Pi changes for this file" &&
      selected.piChange
    ) {
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for Pi to finish before reverting changes",
          "warning",
        );
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        `Revert Pi changes to ${selected.displayPath}?`,
        selected.piChange.kind === "new"
          ? "This deletes the file created by Pi."
          : "This restores the file content from before Pi first changed it.",
      );
      if (confirmed) {
        notifyRevertResult(
          ctx,
          await changeTracker.revertFile(selected.canonicalPath),
        );
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Extension export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  const changeTracker = registerFileChangeTracking(pi);

  pi.registerCommand("files", {
    description: "Browse files with git status and Pi change review",
    handler: async (_args, ctx) => {
      await runFileBrowser(pi, ctx, changeTracker);
    },
  });

  pi.registerShortcut("ctrl+shift+o", {
    description: "Browse files mentioned or changed in the session",
    handler: async (ctx) => {
      await runFileBrowser(pi, ctx, changeTracker);
    },
  });
}
