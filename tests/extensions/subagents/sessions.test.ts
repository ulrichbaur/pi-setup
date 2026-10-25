import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  listSavedSessions,
  newSessionId,
  pruneSessions,
  sessionAgent,
  sessionArguments,
  sessionName,
} from "../../../extensions/subagents/sessions.ts";
import { withTempDir } from "../../helpers.ts";

test("session ids carry the agent name", () => {
  const id = newSessionId("code-review", () => "0a1b2c3d");
  assert.equal(id, "code-review-0a1b2c3d");
  assert.equal(sessionAgent(id), "code-review");
  assert.match(newSessionId("scout"), /^scout-[0-9a-f]{8}$/);
  assert.equal(sessionAgent("scout"), undefined);
  assert.equal(sessionAgent("scout-0A1B2C3D"), undefined);
  assert.equal(sessionAgent("../scout-0a1b2c3d"), undefined);
});

test("session names show the agent and the start of the task", () => {
  assert.equal(
    sessionName("scout", "  Find\n the parser "),
    "scout: Find the parser",
  );
  assert.equal(
    sessionName("scout", "x".repeat(70)),
    `scout: ${"x".repeat(60)}…`,
  );
});

test("new sessions get an id and name; resumed sessions open their file", () => {
  assert.deepEqual(
    sessionArguments(
      { kind: "new", id: "scout-0a1b2c3d", name: "scout: x" },
      "/s",
    ),
    [
      "--session-dir",
      "/s",
      "--session-id",
      "scout-0a1b2c3d",
      "--name",
      "scout: x",
    ],
  );
  assert.deepEqual(
    sessionArguments(
      { kind: "resume", id: "scout-0a1b2c3d", path: "/s/a.jsonl" },
      "/s",
    ),
    ["--session-dir", "/s", "--session", "/s/a.jsonl"],
  );
});

test("cleanup deletes only session files past the retention period", async () => {
  await withTempDir("subagent-prune-", async (directory) => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1_000;
    const file = (name: string, ageDays: number) => {
      const path = join(directory, name);
      writeFileSync(path, "{}\n");
      const time = new Date(now - ageDays * day);
      utimesSync(path, time, time);
      return path;
    };
    const old = file("old.jsonl", 91);
    const recent = file("recent.jsonl", 89);
    const other = file("notes.txt", 400);

    assert.equal(await pruneSessions(90, directory, now), 1);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(other), true);
  });
  assert.equal(await pruneSessions(90, "/nonexistent/subagent-sessions"), 0);
});

test("saved sessions list their names, newest change first", async () => {
  await withTempDir("subagent-list-", (directory) => {
    const file = (name: string, lines: unknown[], ageMs: number) => {
      const path = join(directory, name);
      writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
      const time = new Date(Date.now() - ageMs);
      utimesSync(path, time, time);
      return path;
    };
    file(
      "2026-10-01T00-00-00-000Z_scout-0000000a.jsonl",
      [
        { type: "session", cwd: "/repo" },
        { type: "session_info", name: "scout: map it" },
      ],
      60_000,
    );
    file("2026-10-02T00-00-00-000Z_worker-0000000b.jsonl", ["broken"], 1_000);
    writeFileSync(join(directory, "notes.txt"), "ignored");

    const sessions = listSavedSessions(10, directory);
    assert.deepEqual(
      sessions.map(({ id, name, cwd }) => [id, name, cwd]),
      [
        ["worker-0000000b", "worker-0000000b", ""],
        ["scout-0000000a", "scout: map it", "/repo"],
      ],
    );
    assert.equal(listSavedSessions(1, directory).length, 1);
  });
  assert.deepEqual(listSavedSessions(10, "/nonexistent/subagent-sessions"), []);
});
