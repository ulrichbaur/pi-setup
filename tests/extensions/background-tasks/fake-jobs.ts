import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type Job,
  jobDir,
  readJob,
  saveJob,
  startJob,
} from "../../../extensions/background-tasks/runner.ts";

export const session = "00112233-4455-6677-8899-aabbccddeeff";

export async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for job");
    await delay(25);
  }
}

/** Starts a real job and returns its directory once it runs. */
export async function running(root: string, command: string): Promise<string> {
  const job = await startJob(root, session, { cwd: root, command });
  const dir = jobDir(root, session, job.id);
  await until(() => readJob(dir).state === "running");
  return dir;
}

/** Writes a job record without a supervisor behind it. */
export function record(root: string, id: string, fields: Partial<Job>): string {
  const dir = jobDir(root, session, id);
  mkdirSync(dir, { recursive: true });
  saveJob(dir, {
    id,
    command: "true",
    cwd: root,
    timeoutMs: null,
    socketPath: join(root, "missing.sock"),
    createdAt: new Date().toISOString(),
    state: "running",
    ...fields,
  });
  return dir;
}
