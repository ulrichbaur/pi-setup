import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerGuards,
  runningWork,
  workText,
} from "../../../extensions/background-work/guard.ts";
import { RunRegistry } from "../../../extensions/background-work/subagents/runs.ts";
import type { JobRegistry } from "../../../extensions/background-work/tasks/registry.ts";
import { fakeRun } from "./subagents/fake-run.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(work: { jobs: number; subagents: number }, answer: boolean) {
  const handlers: Record<string, Handler> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  registerGuards(pi, () => work);
  const dialogs: Array<[string, string]> = [];
  const ctx = (hasUI = true) => ({
    hasUI,
    ui: {
      confirm: async (title: string, message: string) => {
        dialogs.push([title, message]);
        return answer;
      },
    },
  });
  const fire = (event: string, hasUI = true) =>
    handlers[event]({ type: event }, ctx(hasUI));
  return { fire, dialogs };
}

test("running work counts jobs and background subagents only", () => {
  const runs = new RunRegistry();
  const background = fakeRun("scout-00000001");
  background.result.runId = "run-1";
  runs.add(background);
  runs.add(fakeRun("scout-00000002"));
  const finished = fakeRun("scout-00000003", "completed");
  finished.result.runId = "run-3";
  runs.add(finished);
  const jobs = { active: () => [{}, {}] } as unknown as JobRegistry;
  assert.deepEqual(
    runningWork(
      { registry: jobs, root: () => "/" },
      { registry: runs, hideThinking: () => false },
    ),
    { jobs: 2, subagents: 1 },
  );
  assert.deepEqual(runningWork(undefined, undefined), {
    jobs: 0,
    subagents: 0,
  });
});

test("the work reads as words", () => {
  assert.equal(
    workText({ jobs: 2, subagents: 1 }),
    "2 shell jobs and 1 subagent",
  );
  assert.equal(workText({ jobs: 1, subagents: 0 }), "1 shell job");
  assert.equal(workText({ jobs: 0, subagents: 3 }), "3 subagents");
  assert.equal(workText({ jobs: 0, subagents: 0 }), "");
});

test("/tree asks first while work runs, and No cancels the move", async () => {
  const { fire, dialogs } = setup({ jobs: 2, subagents: 1 }, false);
  assert.deepEqual(await fire("session_before_tree"), { cancel: true });
  assert.deepEqual(dialogs, [
    [
      "Background work is running",
      "2 shell jobs and 1 subagent are still running. Their results will arrive on the branch you move to, not on the branch that started them. Move anyway?",
    ],
  ]);
});

test("leaving the session asks first, and Yes goes ahead", async () => {
  const { fire, dialogs } = setup({ jobs: 1, subagents: 0 }, true);
  for (const event of ["session_before_switch", "session_before_fork"]) {
    assert.equal(await fire(event), undefined, event);
  }
  assert.deepEqual(
    dialogs.map(([, message]) => message),
    [
      "1 shell job is still running. Leaving this session stops it. Continue?",
      "1 shell job is still running. Leaving this session stops it. Continue?",
    ],
  );
});

test("nothing running, or no dialogs, means no question", async () => {
  const idle = setup({ jobs: 0, subagents: 0 }, false);
  assert.equal(await idle.fire("session_before_tree"), undefined);
  const headless = setup({ jobs: 1, subagents: 1 }, false);
  assert.equal(await headless.fire("session_before_switch", false), undefined);
  assert.deepEqual([...idle.dialogs, ...headless.dialogs], []);
});
