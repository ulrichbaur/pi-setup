import { randomBytes } from "node:crypto";
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/is-record.ts";

// Kept apart from Pi's default session directory, so subagent sessions stay
// out of /resume and out of the skillset history.
export const SESSIONS_DIR = join(getAgentDir(), "subagents", "sessions");
// Pi session ids must start and end with a letter or digit.
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SESSION_ID_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_-]*)-[0-9a-f]{8}$/;
const NAME_TASK_LENGTH = 60;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type SessionTarget =
  | { kind: "new"; id: string; name: string }
  | { kind: "resume"; id: string; path: string };

export function newSessionId(
  agent: string,
  random: () => string = () => randomBytes(4).toString("hex"),
): string {
  return `${agent}-${random()}`;
}

export function sessionAgent(id: string): string | undefined {
  return SESSION_ID_PATTERN.exec(id)?.[1];
}

export function sessionName(agent: string, task: string): string {
  const start = task.replace(/\s+/g, " ").trim();
  return `${agent}: ${start.length > NAME_TASK_LENGTH ? `${start.slice(0, NAME_TASK_LENGTH)}…` : start}`;
}

export function findSession(
  id: string,
  directory: string = SESSIONS_DIR,
): string | undefined {
  if (!sessionAgent(id)) return undefined;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return undefined;
  }
  const name = names.find((candidate) => candidate.endsWith(`_${id}.jsonl`));
  return name ? join(directory, name) : undefined;
}

/** The session id in a file name of the form `<timestamp>_<id>.jsonl`. */
export function sessionIdOf(path: string): string {
  return basename(path, ".jsonl").split("_").at(-1) ?? "";
}

export interface SavedSession {
  id: string;
  path: string;
  // The name given at creation, or the id when the file has none.
  name: string;
  cwd: string;
  modifiedMs: number;
}

// The header and the session name are the first lines Pi writes.
const HEAD_BYTES = 8_192;

function readHead(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const length = readSync(descriptor, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function describe(path: string): SavedSession {
  const id = sessionIdOf(path);
  let name = id;
  let cwd = "";
  for (const line of readHead(path).split("\n").slice(0, 8)) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (entry.type === "session" && typeof entry.cwd === "string") {
      cwd = entry.cwd;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") {
      name = entry.name;
    }
  }
  return { id, path, name, cwd, modifiedMs: statSync(path).mtimeMs };
}

/**
 * A file that cannot be read is left out;
 * the list is a convenience, not a record.
 */
export function listSavedSessions(
  limit: number,
  directory: string = SESSIONS_DIR,
): SavedSession[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const sessions: SavedSession[] = [];
  for (const name of names.filter((file) => file.endsWith(".jsonl"))) {
    try {
      sessions.push(describe(join(directory, name)));
    } catch {
      // Deleted or unreadable since the directory was read.
    }
  }
  return sessions.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, limit);
}

export function readSessionCwd(path: string): string {
  const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    throw new Error(`${path}: session header is not valid JSON`);
  }
  if (
    !isRecord(header) ||
    header.type !== "session" ||
    typeof header.cwd !== "string"
  ) {
    throw new Error(`${path}: session header has no working directory`);
  }
  return header.cwd;
}

export function sessionArguments(
  target: SessionTarget,
  directory: string = SESSIONS_DIR,
): string[] {
  return target.kind === "new"
    ? [
        "--session-dir",
        directory,
        "--session-id",
        target.id,
        "--name",
        target.name,
      ]
    : ["--session-dir", directory, "--session", target.path];
}

/** Age counts from a file's last change. */
export async function pruneSessions(
  maxAgeDays: number,
  directory: string = SESSIONS_DIR,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let deleted = 0;
  for (const name of names.filter((candidate) =>
    candidate.endsWith(".jsonl"),
  )) {
    const path = join(directory, name);
    const { mtimeMs } = await stat(path);
    if (now - mtimeMs > maxAgeDays * DAY_MS) {
      await rm(path, { force: true });
      deleted += 1;
    }
  }
  return deleted;
}
