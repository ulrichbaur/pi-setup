import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  countChangedLines,
  createChangeDiff,
  MAX_SNAPSHOT_BYTES,
  normalizeChangePath,
  registerFileChangeTracking,
} from "../extensions/files/changes.ts";
import { withTempDir } from "./helpers.ts";

type EventHandler = (event: any, ctx: ExtensionContext) => Promise<void> | void;

function createHarness(cwd: string, restoredEntries: SessionEntry[] = []) {
  const handlers = new Map<string, EventHandler>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const context = {
    cwd,
    sessionManager: { getBranch: () => restoredEntries },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, context, handlers, appended, notifications };
}

async function invoke(
  handlers: Map<string, EventHandler>,
  name: string,
  event: object,
  context: ExtensionContext,
): Promise<void> {
  const handler = handlers.get(name);
  assert.ok(handler, `missing ${name} handler`);
  await handler(event, context);
}

function customEntries(
  appended: Array<{ customType: string; data: unknown }>,
): SessionEntry[] {
  return appended.map(
    (item, index) =>
      ({
        type: "custom",
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: new Date(index).toISOString(),
        customType: item.customType,
        data: item.data,
      }) as SessionEntry,
  );
}

async function trackWrite(
  harness: ReturnType<typeof createHarness>,
  target: string,
  content: string,
  toolCallId = "write-1",
): Promise<void> {
  await invoke(
    harness.handlers,
    "tool_call",
    {
      type: "tool_call",
      toolName: "write",
      toolCallId,
      input: { path: target },
    },
    harness.context,
  );
  await writeFile(target, content, "utf8");
  await invoke(
    harness.handlers,
    "tool_result",
    {
      type: "tool_result",
      toolName: "write",
      toolCallId,
      input: { path: target },
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
    },
    harness.context,
  );
}

test("change helpers normalize paths and count unified diff lines", () => {
  assert.deepEqual(normalizeChangePath("/tmp/project", "@src/index.ts"), {
    storagePath: join("src", "index.ts"),
    absolutePath: join("/tmp/project", "src", "index.ts"),
  });
  const diff = createChangeDiff("file.txt", "one\ntwo\n", "one\nthree\n");
  assert.deepEqual(countChangedLines(diff), { added: 1, removed: 1 });
});

test("tracker restores an edited file to its original content", () =>
  withTempDir("file-changes-test-", async (directory) => {
    const target = join(directory, "file.txt");
    await writeFile(target, "before\n", "utf8");
    const harness = createHarness(directory);
    const tracker = registerFileChangeTracking(harness.pi);
    await invoke(
      harness.handlers,
      "session_start",
      { type: "session_start", reason: "startup" },
      harness.context,
    );

    await trackWrite(harness, target, "after\n");
    assert.equal(tracker.list().length, 1);
    assert.equal(tracker.list()[0].kind, "edited");
    assert.deepEqual(
      { added: tracker.list()[0].added, removed: tracker.list()[0].removed },
      { added: 1, removed: 1 },
    );

    const result = await tracker.revertFile(target);
    assert.deepEqual(result, {
      reverted: ["file.txt"],
      conflicts: [],
      errors: [],
    });
    assert.equal(await readFile(target, "utf8"), "before\n");
    assert.equal(tracker.list().length, 0);
  }));

test("tracker deletes a safely reverted file created by Pi", () =>
  withTempDir("file-changes-new-test-", async (directory) => {
    const target = join(directory, "created.txt");
    const harness = createHarness(directory);
    const tracker = registerFileChangeTracking(harness.pi);
    await trackWrite(harness, target, "created\n");

    assert.equal(tracker.list()[0].kind, "new");
    assert.deepEqual((await tracker.revertFile(target)).reverted, [
      "created.txt",
    ]);
    await assert.rejects(access(target));
  }));

test("tracker detects external edits and skips rollback", () =>
  withTempDir("file-changes-conflict-test-", async (directory) => {
    const target = join(directory, "file.txt");
    await writeFile(target, "before\n", "utf8");
    const harness = createHarness(directory);
    const tracker = registerFileChangeTracking(harness.pi);
    await trackWrite(harness, target, "after Pi\n");

    await writeFile(target, "external edit\n", "utf8");
    await tracker.refresh(harness.context);
    assert.equal(tracker.get(target)?.conflict, true);

    const result = await tracker.revertFile(target);
    assert.deepEqual(result, {
      reverted: [],
      conflicts: ["file.txt"],
      errors: [],
    });
    assert.equal(await readFile(target, "utf8"), "external edit\n");
  }));

test("tracker restores branch-aware state from session entries", () =>
  withTempDir("file-changes-restore-test-", async (directory) => {
    const target = join(directory, "file.txt");
    await writeFile(target, "before\n", "utf8");
    const first = createHarness(directory);
    registerFileChangeTracking(first.pi);
    await trackWrite(first, target, "after\n");

    const restored = createHarness(directory, customEntries(first.appended));
    const tracker = registerFileChangeTracking(restored.pi);
    await invoke(
      restored.handlers,
      "session_start",
      { type: "session_start", reason: "resume" },
      restored.context,
    );
    assert.equal(tracker.list().length, 1);
    assert.equal(tracker.list()[0].conflict, false);
    assert.equal(tracker.list()[0].originalContent, "before\n");
  }));

test("tracker skips existing files larger than the 3 MiB snapshot limit", () =>
  withTempDir("file-changes-large-test-", async (directory) => {
    const target = join(directory, "large.txt");
    await writeFile(target, "x".repeat(MAX_SNAPSHOT_BYTES + 1), "utf8");
    const harness = createHarness(directory);
    const tracker = registerFileChangeTracking(harness.pi);

    await trackWrite(harness, target, "replacement\n");
    assert.equal(tracker.list().length, 0);
    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0], /exceeds 3 MiB/);
  }));
