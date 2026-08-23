import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  isEditToolResult,
  isToolCallEventType,
  isWriteToolResult,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch } from "diff";
import { formatDisplayPath } from "./utils.ts";

export const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;

const BASELINE_ENTRY = "files:change-baseline";
const CHECKPOINT_ENTRY = "files:change-checkpoint";
const RESOLVE_ENTRY = "files:change-resolve";
const CLEAR_ENTRY = "files:change-clear";

type Baseline = {
  storagePath: string;
  absolutePath: string;
  originalContent: string | null;
};

type Checkpoint = {
  expectedHash: string;
  conflict: boolean;
  updatedAt: number;
};

type PendingSnapshot = {
  storagePath: string;
  absolutePath: string;
  before: string | null;
  conflict: boolean;
};

export type TrackedFileChange = {
  storagePath: string;
  absolutePath: string;
  displayPath: string;
  originalContent: string | null;
  currentContent: string | null;
  expectedHash: string;
  diff: string;
  added: number;
  removed: number;
  kind: "new" | "edited";
  conflict: boolean;
  updatedAt: number;
};

export type RevertChangesResult = {
  reverted: string[];
  conflicts: string[];
  errors: string[];
};

export interface FileChangeTracker {
  list(): TrackedFileChange[];
  get(absolutePath: string): TrackedFileChange | undefined;
  refresh(ctx: ExtensionContext): Promise<void>;
  acceptFile(absolutePath: string): boolean;
  acceptAll(): number;
  revertFile(absolutePath: string): Promise<RevertChangesResult>;
  revertAll(): Promise<RevertChangesResult>;
}

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function normalizeChangePath(
  cwd: string,
  rawPath: string,
): { storagePath: string; absolutePath: string } {
  const cleaned = stripAtPrefix(rawPath);
  const absolutePath = path.resolve(cwd, cleaned);
  const relativePath = path.relative(cwd, absolutePath);
  const storagePath =
    relativePath &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
      ? relativePath
      : absolutePath;
  return { storagePath, absolutePath };
}

function resolveStoragePath(cwd: string, storagePath: string): string {
  return path.isAbsolute(storagePath)
    ? path.normalize(storagePath)
    : path.resolve(cwd, storagePath);
}

function contentHash(content: string | null): string {
  if (content === null) return "missing";
  return createHash("sha256").update(content).digest("hex");
}

async function readCurrent(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readSnapshot(absolutePath: string): Promise<string | null> {
  try {
    const file = await stat(absolutePath);
    if (file.size > MAX_SNAPSHOT_BYTES) {
      throw new SnapshotTooLargeError(file.size);
    }
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isAtBaseline(
  baseline: Baseline,
  currentContent: string | null,
): boolean {
  return currentContent === baseline.originalContent;
}

export function createChangeDiff(
  filename: string,
  originalContent: string | null,
  currentContent: string | null,
): string {
  return createTwoFilesPatch(
    filename,
    filename,
    originalContent ?? "",
    currentContent ?? "",
    "",
    "",
    { context: 3 },
  );
}

export function countChangedLines(diff: string): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("@@")
    ) {
      continue;
    }
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

class SnapshotTooLargeError extends Error {
  readonly size: number;

  constructor(size: number) {
    super(`file is ${size} bytes`);
    this.size = size;
  }
}

export function registerFileChangeTracking(
  pi: ExtensionAPI,
): FileChangeTracker {
  const baselines = new Map<string, Baseline>();
  const checkpoints = new Map<string, Checkpoint>();
  const tracked = new Map<string, TrackedFileChange>();
  const pending = new Map<string, PendingSnapshot>();
  const skippedLargeFiles = new Set<string>();
  let cwd = process.cwd();

  function appendBaseline(baseline: Baseline): void {
    pi.appendEntry(BASELINE_ENTRY, {
      version: 1,
      path: baseline.storagePath,
      originalContent: baseline.originalContent,
    });
  }

  function appendCheckpoint(storagePath: string, checkpoint: Checkpoint): void {
    pi.appendEntry(CHECKPOINT_ENTRY, {
      version: 1,
      path: storagePath,
      expectedHash: checkpoint.expectedHash,
      conflict: checkpoint.conflict,
      updatedAt: checkpoint.updatedAt,
    });
  }

  function resolveChange(
    storagePath: string,
    reason: "accepted" | "reverted" | "baseline",
  ): void {
    baselines.delete(storagePath);
    checkpoints.delete(storagePath);
    const absolutePath = resolveStoragePath(cwd, storagePath);
    tracked.delete(absolutePath);
    pi.appendEntry(RESOLVE_ENTRY, { version: 1, path: storagePath, reason });
  }

  function setTrackedChange(
    baseline: Baseline,
    currentContent: string | null,
    checkpoint: Checkpoint,
  ): void {
    const name = formatDisplayPath(baseline.absolutePath, cwd);
    const diff = createChangeDiff(
      name,
      baseline.originalContent,
      currentContent,
    );
    const counts = countChangedLines(diff);
    tracked.set(baseline.absolutePath, {
      storagePath: baseline.storagePath,
      absolutePath: baseline.absolutePath,
      displayPath: name,
      originalContent: baseline.originalContent,
      currentContent,
      expectedHash: checkpoint.expectedHash,
      diff,
      ...counts,
      kind: baseline.originalContent === null ? "new" : "edited",
      conflict: checkpoint.conflict,
      updatedAt: checkpoint.updatedAt,
    });
  }

  async function refreshBaseline(
    baseline: Baseline,
    persistState: boolean,
  ): Promise<void> {
    const currentContent = await readCurrent(baseline.absolutePath);
    if (isAtBaseline(baseline, currentContent)) {
      if (persistState) resolveChange(baseline.storagePath, "baseline");
      else tracked.delete(baseline.absolutePath);
      return;
    }

    let checkpoint = checkpoints.get(baseline.storagePath);
    if (!checkpoint) {
      checkpoint = {
        expectedHash: contentHash(currentContent),
        conflict: true,
        updatedAt: Date.now(),
      };
      checkpoints.set(baseline.storagePath, checkpoint);
      if (persistState) appendCheckpoint(baseline.storagePath, checkpoint);
    } else if (
      !checkpoint.conflict &&
      contentHash(currentContent) !== checkpoint.expectedHash
    ) {
      checkpoint = { ...checkpoint, conflict: true, updatedAt: Date.now() };
      checkpoints.set(baseline.storagePath, checkpoint);
      if (persistState) appendCheckpoint(baseline.storagePath, checkpoint);
    }
    setTrackedChange(baseline, currentContent, checkpoint);
  }

  async function rebuild(ctx: ExtensionContext): Promise<void> {
    cwd = ctx.cwd;
    baselines.clear();
    checkpoints.clear();
    tracked.clear();
    pending.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data;
      if (!data || typeof data !== "object") continue;
      const value = data as Record<string, unknown>;

      if (entry.customType === CLEAR_ENTRY) {
        baselines.clear();
        checkpoints.clear();
        continue;
      }
      if (typeof value.path !== "string") continue;

      if (entry.customType === BASELINE_ENTRY) {
        const originalContent = value.originalContent;
        if (originalContent !== null && typeof originalContent !== "string") {
          continue;
        }
        baselines.set(value.path, {
          storagePath: value.path,
          absolutePath: resolveStoragePath(cwd, value.path),
          originalContent,
        });
        checkpoints.delete(value.path);
      } else if (
        entry.customType === CHECKPOINT_ENTRY &&
        typeof value.expectedHash === "string"
      ) {
        checkpoints.set(value.path, {
          expectedHash: value.expectedHash,
          conflict: value.conflict === true,
          updatedAt:
            typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
        });
      } else if (entry.customType === RESOLVE_ENTRY) {
        baselines.delete(value.path);
        checkpoints.delete(value.path);
      }
    }

    await refreshBaselines(true);
  }

  async function refreshBaselines(persistState: boolean): Promise<void> {
    for (const baseline of [...baselines.values()]) {
      try {
        await refreshBaseline(baseline, persistState);
      } catch {
        // Keep the last known state if a tracked file is temporarily unreadable.
      }
    }
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    cwd = ctx.cwd;
    await refreshBaselines(true);
  }

  async function revertOne(absolutePath: string): Promise<RevertChangesResult> {
    const result: RevertChangesResult = {
      reverted: [],
      conflicts: [],
      errors: [],
    };
    const change = tracked.get(path.resolve(absolutePath));
    if (!change) return result;

    try {
      await withFileMutationQueue(change.absolutePath, async () => {
        const currentContent = await readCurrent(change.absolutePath);
        if (
          change.conflict ||
          contentHash(currentContent) !== change.expectedHash
        ) {
          result.conflicts.push(change.displayPath);
          return;
        }

        if (change.originalContent === null) {
          await rm(change.absolutePath, { force: true });
        } else {
          await mkdir(path.dirname(change.absolutePath), { recursive: true });
          await writeFile(change.absolutePath, change.originalContent, "utf8");
        }
        resolveChange(change.storagePath, "reverted");
        result.reverted.push(change.displayPath);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${change.displayPath}: ${message}`);
    }
    return result;
  }

  const tracker: FileChangeTracker = {
    list() {
      return [...tracked.values()].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
    },
    get(absolutePath) {
      return tracked.get(path.resolve(absolutePath));
    },
    refresh,
    acceptFile(absolutePath) {
      const change = tracked.get(path.resolve(absolutePath));
      if (!change) return false;
      resolveChange(change.storagePath, "accepted");
      return true;
    },
    acceptAll() {
      const count = tracked.size;
      if (count === 0) return 0;
      baselines.clear();
      checkpoints.clear();
      tracked.clear();
      pi.appendEntry(CLEAR_ENTRY, { version: 1, reason: "accepted" });
      return count;
    },
    revertFile: revertOne,
    async revertAll() {
      const combined: RevertChangesResult = {
        reverted: [],
        conflicts: [],
        errors: [],
      };
      for (const change of [...tracked.values()]) {
        const result = await revertOne(change.absolutePath);
        combined.reverted.push(...result.reverted);
        combined.conflicts.push(...result.conflicts);
        combined.errors.push(...result.errors);
      }
      return combined;
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    await rebuild(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await rebuild(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (
      !isToolCallEventType("edit", event) &&
      !isToolCallEventType("write", event)
    ) {
      return;
    }

    const normalized = normalizeChangePath(ctx.cwd, event.input.path);
    try {
      const baseline = baselines.get(normalized.storagePath);
      const before = baseline
        ? await readCurrent(normalized.absolutePath)
        : await readSnapshot(normalized.absolutePath);
      const checkpoint = checkpoints.get(normalized.storagePath);
      const conflict = baseline
        ? !isAtBaseline(baseline, before) &&
          (checkpoint?.conflict === true ||
            checkpoint?.expectedHash !== contentHash(before))
        : false;
      pending.set(event.toolCallId, { ...normalized, before, conflict });
    } catch (error) {
      pending.delete(event.toolCallId);
      if (
        error instanceof SnapshotTooLargeError &&
        !skippedLargeFiles.has(normalized.absolutePath)
      ) {
        skippedLargeFiles.add(normalized.absolutePath);
        ctx.ui.notify(
          `Change rollback is not tracking ${formatDisplayPath(normalized.absolutePath, ctx.cwd)} because its original content exceeds 3 MiB`,
          "warning",
        );
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
    const snapshot = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!snapshot || event.isError) return;

    try {
      const currentContent = await readCurrent(snapshot.absolutePath);
      let baseline = baselines.get(snapshot.storagePath);
      if (!baseline) {
        baseline = {
          storagePath: snapshot.storagePath,
          absolutePath: snapshot.absolutePath,
          originalContent: snapshot.before,
        };
        baselines.set(snapshot.storagePath, baseline);
        appendBaseline(baseline);
      }

      if (isAtBaseline(baseline, currentContent)) {
        resolveChange(snapshot.storagePath, "baseline");
        return;
      }

      const previous = checkpoints.get(snapshot.storagePath);
      const checkpoint = {
        expectedHash: contentHash(currentContent),
        conflict:
          snapshot.conflict ||
          previous?.conflict === true ||
          (previous !== undefined &&
            !isAtBaseline(baseline, snapshot.before) &&
            previous.expectedHash !== contentHash(snapshot.before)),
        updatedAt: Date.now(),
      };
      checkpoints.set(snapshot.storagePath, checkpoint);
      appendCheckpoint(snapshot.storagePath, checkpoint);
      cwd = ctx.cwd;
      setTrackedChange(baseline, currentContent, checkpoint);
    } catch {
      // Tracking failure must never turn a successful file tool call into an error.
    }
  });

  return tracker;
}
