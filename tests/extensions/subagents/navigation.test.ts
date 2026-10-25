import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fakeRun } from "./fake-run.ts";

// The modules resolve the agent directory when they load.
const agentDir = mkdtempSync(join(tmpdir(), "subagent-navigation-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));
const navigation = await import("../../../extensions/subagents/navigation.ts");
const { RunRegistry } = await import("../../../extensions/subagents/runs.ts");
const { SESSIONS_DIR } = await import(
  "../../../extensions/subagents/sessions.ts"
);

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const message = (role: string, text: string) =>
  line({
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  });

function session(id: string, ...messages: string[]): string {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const path = join(SESSIONS_DIR, `2026-10-25T10-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    line({ type: "session", cwd: "/repo" }) + messages.join(""),
  );
  return path;
}

function parentSession(): string {
  const path = join(agentDir, `parent-${Math.random()}.jsonl`);
  writeFileSync(path, line({ type: "session", cwd: "/repo" }));
  return path;
}

function fakeContext(options: {
  current?: string;
  idle?: boolean;
  confirm?: boolean;
  cancel?: boolean;
}) {
  const notices: string[] = [];
  const switched: string[] = [];
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const ctx = {
    isIdle: () => options.idle ?? true,
    sessionManager: { getSessionFile: () => options.current },
    ui: {
      notify: (text: string) => notices.push(text),
      confirm: async () => options.confirm ?? true,
    },
    switchSession: async (
      path: string,
      switchOptions?: { withSession?: (next: unknown) => Promise<void> },
    ) => {
      switched.push(path);
      await switchOptions?.withSession?.({
        sendMessage: async (message: unknown, sendOptions: unknown) => {
          sent.push({ message, options: sendOptions });
        },
      });
      return { cancelled: options.cancel ?? false };
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notices, switched, sent };
}

test("return points round-trip, drop stale entries, and name a bad file", () => {
  const path = join(agentDir, "returns-test.json");
  const target = session("scout-0000000a", message("user", "hi"));
  const parent = parentSession();
  writeFileSync(
    path,
    JSON.stringify({ "/gone.jsonl": { parent, messages: 1 } }),
  );
  navigation.recordReturn(target, parent, path);
  assert.deepEqual(navigation.readReturns(path), {
    [target]: { parent, messages: 1 },
  });
  assert.deepEqual(navigation.takeReturn(target, path), {
    parent,
    messages: 1,
  });
  assert.deepEqual(navigation.readReturns(path), {});
  assert.deepEqual(navigation.readReturns(join(agentDir, "missing.json")), {});

  writeFileSync(path, "{");
  assert.throws(() => navigation.readReturns(path), {
    message: `${path}: invalid JSON`,
  });
});

test("the return note carries the newest answer, only after new work", () => {
  const path = session(
    "worker-0000000b",
    message("user", "Task: fix it"),
    message("assistant", "Fixed."),
  );
  const point = { parent: "/p.jsonl", messages: 2 };
  assert.equal(
    navigation.returnNote(path, "worker-0000000b", point),
    undefined,
  );

  appendFileSync(
    path,
    message("user", "also add a test") +
      message("assistant", "Test added.") +
      message("toolResult", "ignored"),
  );
  assert.equal(
    navigation.returnNote(path, "worker-0000000b", point),
    "The user continued subagent session worker-0000000b directly. Its last answer:\n\nTest added.\n\nResume it with this session id to build on that work.",
  );
});

test("opening a session confirms, stops running subagents, and records the way back", async () => {
  const target = session("scout-0000000c", message("user", "Task"));
  const parent = parentSession();
  const registry = new RunRegistry();
  const running = fakeRun("worker-0000000d");
  running.stop.signal.addEventListener("abort", () => {
    running.result.progress.status = "failed";
    registry.changed();
  });
  registry.add(running);

  const declined = fakeContext({ current: parent, confirm: false });
  await navigation.openSubagentSession(
    declined.ctx,
    registry,
    "scout-0000000c",
  );
  assert.deepEqual(declined.switched, []);
  assert.equal(running.stop.signal.aborted, false);

  const accepted = fakeContext({ current: parent });
  await navigation.openSubagentSession(
    accepted.ctx,
    registry,
    "scout-0000000c",
  );
  assert.equal(running.stop.signal.aborted, true);
  assert.deepEqual(accepted.switched, [target]);
  assert.deepEqual(navigation.readReturns()[target], { parent, messages: 1 });
});

test("opening refuses while busy, for unknown ids, and from unsaved sessions", async () => {
  session("scout-0000000e");
  const registry = new RunRegistry();
  const cases = [
    {
      options: { current: "/p.jsonl", idle: false },
      id: "scout-0000000e",
      notice: /Wait until the current run ends/,
    },
    {
      options: { current: "/p.jsonl" },
      id: "scout-ffffffff",
      notice: /Unknown subagent session scout-ffffffff/,
    },
    { options: {}, id: "scout-0000000e", notice: /not saved/ },
  ];
  for (const { options, id, notice } of cases) {
    const { ctx, notices, switched } = fakeContext(options);
    await navigation.openSubagentSession(ctx, registry, id);
    assert.deepEqual(switched, []);
    assert.match(notices.join("\n"), notice);
  }
});

test("going back returns to the parent and leaves the model a note", async () => {
  const target = session(
    "worker-0000000f",
    message("user", "Task"),
    message("assistant", "Done."),
  );
  const parent = parentSession();
  navigation.recordReturn(target, parent);
  appendFileSync(
    target,
    message("user", "rename it") + message("assistant", "Renamed."),
  );

  const { ctx, switched, sent } = fakeContext({ current: target });
  await navigation.returnToParent(ctx);
  assert.deepEqual(switched, [parent]);
  assert.deepEqual(sent, [
    {
      message: {
        customType: navigation.RETURN_MESSAGE_TYPE,
        content:
          "The user continued subagent session worker-0000000f directly. Its last answer:\n\nRenamed.\n\nResume it with this session id to build on that work.",
        display: true,
      },
      options: { deliverAs: "nextTurn" },
    },
  ]);
  assert.equal(navigation.readReturns()[target], undefined);

  const again = fakeContext({ current: target });
  await navigation.returnToParent(again.ctx);
  assert.deepEqual(again.switched, []);
  assert.match(again.notices.join("\n"), /No parent session is recorded/);
});
