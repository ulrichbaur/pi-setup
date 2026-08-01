import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";

// Isolate the global session scan from the developer's real agent state.
const home = await mkdtemp(join(tmpdir(), "skill-sessions-test-"));
const agentDirectory = join(home, ".pi", "agent");
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDirectory;

const { collectSkillUsage } = await import("../history/sessions.ts");

const sessionsDir = join(agentDirectory, "sessions");

after(async () => {
  await rm(home, { recursive: true, force: true });
});

function skill(name: string): Skill {
  return {
    name,
    description: name,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
  } as Skill;
}

function headerLine(id: string, cwd: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00Z",
    cwd,
  });
}

// Entry ids must be unique across unrelated fixture sessions: the dedup key
// is (skill, timestamp, id) without a project component, so a reused id at
// the same timestamp merges events from different sessions.
function invocationLine(
  id: string,
  skillName: string,
  timestamp: string,
): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `<skill name="${skillName}" location="/skills/${skillName}/SKILL.md">body</skill>`,
        },
      ],
    },
  });
}

async function writeSession(
  directoryName: string,
  fileName: string,
  lines: string[],
): Promise<string> {
  const directory = join(sessionsDir, directoryName);
  await mkdir(directory, { recursive: true });
  const path = join(directory, fileName);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

function byProject<T extends { project: string }>(
  events: readonly T[],
  project: string,
): T[] {
  return events.filter((event) => event.project === project);
}

test("collects invocations across projects and deduplicates forked copies", async () => {
  const original = [
    headerLine("session-a", "/proj/a"),
    invocationLine("e1", "alpha", "2026-01-02T00:00:00Z"),
    invocationLine("e2", "beta", "2026-01-03T00:00:00Z"),
  ];
  await writeSession("--proj-a--", "a.jsonl", original);
  // A fork copies the history verbatim under a new session id.
  await writeSession("--proj-a--", "a-fork.jsonl", [
    headerLine("session-a-fork", "/proj/a"),
    ...original.slice(1),
  ]);
  await writeSession("--proj-b--", "b.jsonl", [
    headerLine("session-b", "/proj/b"),
    invocationLine("e3", "alpha", "2026-01-04T00:00:00Z"),
  ]);

  const collection = await collectSkillUsage([skill("alpha"), skill("beta")]);

  assert.deepEqual(collection.errors, []);
  assert.deepEqual(
    byProject(collection.events, "/proj/a")
      .map((event) => event.skillName)
      .sort(),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    byProject(collection.events, "/proj/b").map((event) => event.skillName),
    ["alpha"],
  );
});

test("a grown session file invalidates the per-session cache", async () => {
  const path = await writeSession("--proj-c--", "c.jsonl", [
    headerLine("session-c", "/proj/c"),
    invocationLine("c1", "alpha", "2026-01-02T00:00:00Z"),
  ]);
  const inventory = [skill("alpha")];

  const first = await collectSkillUsage(inventory);
  assert.equal(byProject(first.events, "/proj/c").length, 1);

  await appendFile(
    path,
    `${invocationLine("c2", "alpha", "2026-01-05T00:00:00Z")}\n`,
  );
  const second = await collectSkillUsage(inventory);
  assert.equal(byProject(second.events, "/proj/c").length, 2);
});

test("a changed skill inventory invalidates the per-session cache", async () => {
  await writeSession("--proj-d--", "d.jsonl", [
    headerLine("session-d", "/proj/d"),
    invocationLine("d1", "alpha", "2026-01-02T00:00:00Z"),
    invocationLine("d2", "gamma", "2026-01-03T00:00:00Z"),
  ]);

  const first = await collectSkillUsage([skill("alpha")]);
  assert.deepEqual(
    byProject(first.events, "/proj/d").map((event) => event.skillName),
    ["alpha"],
  );

  // Same file, same mtime and size; only the loaded inventory differs.
  const second = await collectSkillUsage([skill("alpha"), skill("gamma")]);
  assert.deepEqual(
    byProject(second.events, "/proj/d")
      .map((event) => event.skillName)
      .sort(),
    ["alpha", "gamma"],
  );
});

test("a malformed session file is reported without aborting the scan", async () => {
  await writeSession("--proj-e--", "good.jsonl", [
    headerLine("session-e", "/proj/e"),
    invocationLine("g1", "alpha", "2026-02-01T00:00:00Z"),
  ]);
  // A valid header gets the file past the session listing; the garbage
  // line must surface as a per-file error instead of being sanitized away.
  const badPath = await writeSession("--proj-f--", "bad.jsonl", [
    headerLine("session-f", "/proj/f"),
    "{ this is not json",
    invocationLine("b1", "alpha", "2026-02-02T00:00:00Z"),
  ]);

  const collection = await collectSkillUsage([skill("alpha")]);

  assert.equal(byProject(collection.events, "/proj/e").length, 1);
  assert.equal(byProject(collection.events, "/proj/f").length, 0);
  const reported = collection.errors.find(
    (error) => error.sessionFile === badPath,
  );
  assert.ok(reported, "the malformed file should be reported");
  assert.match(reported.message, /malformed session line 2/);
});

test("scanning reads old-format session files without rewriting them", async () => {
  const { readFile: readRaw } = await import("node:fs/promises");
  // A version-1 session: no version field, entries without ids. Opening it
  // through SessionManager would migrate it and rewrite the file on disk.
  const raw = [
    JSON.stringify({
      type: "session",
      id: "session-g",
      timestamp: "2026-02-01T00:00:00Z",
      cwd: "/proj/g",
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-02-03T00:00:00Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: '<skill name="alpha" location="/skills/alpha/SKILL.md">body</skill>',
          },
        ],
      },
    }),
  ];
  const path = await writeSession("--proj-g--", "g.jsonl", raw);

  const collection = await collectSkillUsage([skill("alpha")]);

  assert.equal(byProject(collection.events, "/proj/g").length, 1);
  assert.equal(await readRaw(path, "utf8"), `${raw.join("\n")}\n`);
});
