import assert from "node:assert/strict";
import { test } from "node:test";
import {
  footerText,
  watchTaskFooter,
} from "../../../../extensions/background-work/tasks/footer.ts";
import type {
  JobListener,
  JobRegistry,
} from "../../../../extensions/background-work/tasks/registry.ts";
import type { Job } from "../../../../extensions/background-work/tasks/runner.ts";

test("the footer status is labeled and counts running jobs", () => {
  assert.equal(footerText(2), "Tasks: 2 running");
  assert.equal(footerText(0), undefined);
});

test("the footer follows the registry and clears when disposed", () => {
  const jobs: Job[] = [];
  const listeners = new Set<JobListener>();
  const registry = {
    active: () => jobs,
    subscribe: (listener: JobListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as JobRegistry;
  const statuses: Array<[string, string | undefined]> = [];
  const dispose = watchTaskFooter(
    { setStatus: (key, text) => statuses.push([key, text]) },
    registry,
  );
  // Nothing runs, so the footer sets no status.
  assert.deepEqual(statuses, []);

  jobs.push({ id: "a" } as Job);
  for (const listener of listeners) listener(jobs[0], "/jobs/a");
  for (const listener of listeners) listener(jobs[0], "/jobs/a");
  assert.deepEqual(statuses.at(-1), ["background-tasks", "Tasks: 1 running"]);
  assert.equal(statuses.length, 1);

  dispose();
  assert.equal(listeners.size, 0);
  assert.deepEqual(statuses.at(-1), ["background-tasks", undefined]);
});
