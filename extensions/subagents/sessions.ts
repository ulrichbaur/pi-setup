import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

export function recentSessionIds(
  limit: number,
  directory: string = SESSIONS_DIR,
): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(sessionIdOf);
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
