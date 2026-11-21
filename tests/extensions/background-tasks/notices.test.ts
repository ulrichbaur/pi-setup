import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTaskNotices } from "../../../extensions/background-tasks/notices.ts";
import type { TaskRow } from "../../../extensions/background-tasks/task-store.ts";
import { withTempDir } from "../../helpers.ts";

test("notices distinguish live completions, missed completions, and manual stops", async () => {
  await withTempDir("background-notices-", async (root) => {
    const openedAt = Date.parse("2026-01-02T00:00:00Z");
    async function row(
      id: string,
      state: TaskRow["job"]["state"],
      finishedAt: number,
    ): Promise<TaskRow> {
      const dir = join(root, id);
      await mkdir(dir);
      return {
        dir,
        state,
        job: {
          id,
          state,
          finishedAt: new Date(finishedAt).toISOString(),
          createdAt: new Date(0).toISOString(),
          cwd: root,
          command: "true",
          socketPath: "",
          timeoutMs: null,
        },
      };
    }
    const rows = [
      await row("missed", "exited", openedAt - 1),
      await row("stopped", "stopped", openedAt + 1),
      await row("live", "timed_out", openedAt + 1),
    ];
    const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
    const pi: Pick<ExtensionAPI, "sendMessage"> = {
      sendMessage: (...args) => {
        sent.push(args);
      },
    };
    const publish = createTaskNotices(pi, openedAt);
    assert.equal(publish(rows), true);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0][0].details, { jobIds: ["missed", "stopped"] });
    assert.deepEqual(sent[0][1], { deliverAs: "steer", triggerTurn: false });
    assert.match(String(sent[1][0].content), /timed out\.[\s\S]*\/tasks live/);
    assert.deepEqual(sent[1][1], { deliverAs: "steer", triggerTurn: true });
    assert.equal(publish(rows), true);
    assert.equal(createTaskNotices(pi, openedAt + 10)(rows), true);
    assert.equal(sent.length, 2);
  });
});
