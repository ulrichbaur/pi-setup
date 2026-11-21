import { statSync } from "node:fs";
import { type FileHandle, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  isJobId,
  type Job,
  type JobState,
  readJob,
  saveJob,
  sessionDir,
} from "./runner.ts";

export interface TaskRow {
  job: Job;
  state: JobState;
  dir: string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function active(row: TaskRow): boolean {
  return (
    row.state === "running" ||
    row.state === "starting" ||
    row.state === "stopping"
  );
}

export async function sessionTasks(
  root: string,
  sessionId: string,
): Promise<{ rows: TaskRow[]; errors: string[] }> {
  const directory = sessionDir(root, sessionId);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (missing(error)) return [];
      throw error;
    },
  );
  const rows: TaskRow[] = [];
  const errors: string[] = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isJobId(entry.name))
      .map(async (entry) => {
        const dir = join(directory, entry.name);
        try {
          const job = readJob(dir);
          rows.push({ job, state: job.state, dir });
        } catch (error) {
          errors.push(`${entry.name}: ${String(error)}`);
        }
      }),
  );
  rows.sort(
    (a, b) =>
      Number(active(b)) - Number(active(a)) ||
      (b.job.finishedAt ?? b.job.createdAt).localeCompare(
        a.job.finishedAt ?? a.job.createdAt,
      ) ||
      a.job.id.localeCompare(b.job.id),
  );
  return { rows, errors: errors.sort() };
}

/** A full job ID or a prefix of one, in lowercase. */
export const JOB_ID_PREFIX = /^[0-9a-f][0-9a-f-]{0,35}$/;

/** Finds the one job whose ID starts with the prefix. */
export function findTask(
  { rows, errors }: { rows: readonly TaskRow[]; errors: readonly string[] },
  prefix: string,
): { row: TaskRow } | { error: string } {
  const matches = rows.filter((row) => row.job.id.startsWith(prefix));
  const unreadable = errors.filter((message) => message.startsWith(prefix));
  if (matches.length + unreadable.length > 1)
    return { error: "Multiple jobs match. Enter a longer job ID prefix." };
  if (matches[0]) return { row: matches[0] };
  return {
    error: unreadable[0]
      ? terminalText(unreadable[0])
      : "No such background job in this session",
  };
}

function workerAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When the job last wrote output, or when its record last changed. */
function lastActivity(dir: string): string {
  for (const name of ["output.log", "job.json"]) {
    try {
      return statSync(join(dir, name)).mtime.toISOString();
    } catch {
      // Try the next file.
    }
  }
  return new Date().toISOString();
}

/**
 * Marks jobs that Pi never saw end as interrupted, and returns the
 * interrupted jobs not yet announced. A job is left alone while this Pi owns
 * it or its worker still runs, since that worker records the end itself.
 */
export async function interruptedTasks(
  root: string,
  sessionId: string,
  owns: (id: string) => boolean,
): Promise<{ rows: TaskRow[]; errors: string[] }> {
  const snapshot = await sessionTasks(root, sessionId);
  const rows: TaskRow[] = [];
  const errors = [...snapshot.errors];
  for (const row of snapshot.rows) {
    const { job, dir } = row;
    if (!job.finishedAt && !owns(job.id) && !workerAlive(job.workerPid)) {
      row.job = { ...job, state: "interrupted", finishedAt: lastActivity(dir) };
      row.state = "interrupted";
      try {
        saveJob(dir, row.job);
      } catch (error) {
        errors.push(`${job.id}: ${String(error)}`);
        continue;
      }
    }
    if (row.state === "interrupted" && !row.job.noticeSent) rows.push(row);
  }
  return { rows, errors };
}

export function markNoticeSent(row: TaskRow): void {
  row.job = { ...row.job, noticeSent: true };
  saveJob(row.dir, row.job);
}

export function displayJobId(
  id: string,
  { rows, errors }: { rows: readonly TaskRow[]; errors: readonly string[] },
): string {
  const otherIds = [
    ...rows.map((row) => row.job.id),
    ...errors.map((error) => error.split(":", 1)[0]),
  ];
  let length = 5;
  while (
    length < id.length &&
    otherIds.some(
      (other) => other !== id && other.startsWith(id.slice(0, length)),
    )
  )
    length++;
  return id.slice(0, length);
}

export function terminalText(text: string): string {
  return stripVTControlCharacters(text.replaceAll("\t", "    ")).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal controls not covered by the VT parser.
    /[\x00-\x1f\x7f-\x9f]/g,
    "",
  );
}

export const LOG_PAGE_BYTES = 64 * 1024;
export type LogPage = {
  start: number;
  end: number;
  size: number;
  firstLine: number;
  totalLines: number;
  lines: string[];
};
export type LogAnchor = { before: number } | { after: number };

type LineCheckpoint = { offset: number; newlines: number; lastByte?: number };
const BEGINNING: LineCheckpoint = { offset: 0, newlines: 0 };

/** Index the append-only log in bounded chunks and reuse counts as it grows. */
export class LogLineIndex {
  private fileId?: string;
  private size = 0;
  private checkpoints = [BEGINNING];
  private tail = BEGINNING;

  prepare(fileId: string, size: number): void {
    if (fileId !== this.fileId || size < this.size) {
      this.fileId = fileId;
      this.checkpoints = [BEGINNING];
      this.tail = BEGINNING;
    }
    this.size = size;
  }

  async countTo(file: FileHandle, target: number): Promise<LineCheckpoint> {
    const checkpoints = this.checkpoints;
    let point =
      checkpoints[
        Math.min(checkpoints.length - 1, Math.floor(target / LOG_PAGE_BYTES))
      ];
    if (this.tail.offset <= target && this.tail.offset > point.offset)
      point = this.tail;
    if (point.offset === target) return point;
    const bytes = Buffer.alloc(Math.min(LOG_PAGE_BYTES, target - point.offset));
    while (point.offset < target) {
      const block = Math.floor(point.offset / LOG_PAGE_BYTES) + 1;
      const length = Math.min(block * LOG_PAGE_BYTES, target) - point.offset;
      const { bytesRead } = await file.read(bytes, 0, length, point.offset);
      if (!bytesRead) break;
      let newlines = point.newlines;
      for (let i = 0; i < bytesRead; i++) if (bytes[i] === 10) newlines++;
      point = {
        offset: point.offset + bytesRead,
        newlines,
        lastByte: bytes[bytesRead - 1],
      };
      if (point.offset === block * LOG_PAGE_BYTES) checkpoints[block] = point;
    }
    if (checkpoints === this.checkpoints && point.offset > this.tail.offset)
      this.tail = point;
    return point;
  }
}

/** Bound each page while still letting the user scroll through the whole file. */
export async function readLogPage(
  dir: string,
  anchor?: LogAnchor,
  index = new LogLineIndex(),
): Promise<LogPage> {
  const file = await open(join(dir, "output.log"), "r").catch((error) => {
    if (missing(error)) return undefined;
    throw error;
  });
  if (!file)
    return {
      start: 0,
      end: 0,
      size: 0,
      firstLine: 1,
      totalLines: 0,
      lines: [],
    };
  try {
    const { size, dev, ino } = await file.stat();
    index.prepare(`${dev}:${ino}`, size);
    const forward = !!anchor && "after" in anchor;
    const edge = anchor
      ? Math.min(size, "after" in anchor ? anchor.after : anchor.before)
      : size;
    let start = forward ? edge : Math.max(0, edge - LOG_PAGE_BYTES);
    const limit = forward ? Math.min(size, edge + LOG_PAGE_BYTES) : edge;
    let bytes = Buffer.alloc(limit - start);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    bytes = bytes.subarray(0, bytesRead);
    let end = start + bytesRead;
    if (forward && end < size) {
      const newline = bytes.lastIndexOf(10);
      if (newline >= 0) {
        bytes = bytes.subarray(0, newline + 1);
        end = start + bytes.length;
      }
    } else if (!forward && start > 0) {
      const newline = bytes.indexOf(10);
      if (newline >= 0 && newline + 1 < bytes.length) {
        start += newline + 1;
        bytes = bytes.subarray(newline + 1);
      }
    }
    const lines = bytes.length
      ? bytes.toString("utf8").replace(/\n$/, "").split("\n").map(terminalText)
      : [];
    const firstLine = (await index.countTo(file, start)).newlines + 1;
    const tail = await index.countTo(file, size);
    const totalLines =
      tail.newlines + (tail.offset && tail.lastByte !== 10 ? 1 : 0);
    return { start, end, size, firstLine, totalLines, lines };
  } finally {
    await file.close();
  }
}
