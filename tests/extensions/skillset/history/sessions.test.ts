import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectSkillUsage } from "../../../../extensions/skillset/history/sessions.ts";

const invocation = {
  type: "message",
  id: "stable",
  timestamp: "2026-01-02T00:00:00Z",
  message: {
    role: "user",
    content:
      '<skill name="deleted" location="/gone/SKILL.md">\nReferences are relative to /gone.\n\nhistorical\n</skill>',
  },
};

test("scans all files, reports malformed files and deduplicates native fork inheritance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-scan-"));
  try {
    const originalPath = join(directory, "z-original.jsonl");
    const save = async (
      name: string,
      id: string,
      cwd: string,
      entries: unknown[],
      parentSession?: string,
    ) => {
      const path = join(directory, name);
      const raw = [
        JSON.stringify({ type: "session", id, cwd, parentSession }),
        ...entries.map((entry) => JSON.stringify(entry)),
      ].join("\n");
      await writeFile(path, raw);
      return { path, raw };
    };
    await save(
      "a-fork.jsonl",
      "fork",
      "/other",
      [
        invocation,
        { ...invocation, id: "new", timestamp: "2026-01-03T00:00:00Z" },
      ],
      originalPath,
    );
    const original = await save("z-original.jsonl", "origin", "/original", [
      invocation,
    ]);
    // Unrelated short IDs do not establish inheritance.
    await save("unrelated.jsonl", "unrelated", "/unrelated", [invocation]);
    await save("empty.jsonl", "empty", "/empty", []);
    await save("legacy.jsonl", "legacy", "/legacy", [
      { ...invocation, id: undefined },
    ]);
    await writeFile(join(directory, "bad-header.jsonl"), "not json\n");
    await writeFile(
      join(directory, "bad-tail.jsonl"),
      `${JSON.stringify({ type: "session" })}\n{`,
    );
    await writeFile(join(directory, "wrong-header.jsonl"), "{}\n");
    const result = await collectSkillUsage(directory);
    assert.equal(result.sessionsAnalyzed, 5);
    assert.equal(result.errors.length, 3);
    assert.equal(result.events.length, 4);
    assert.equal(
      result.events.filter((event) => event.sessionId === "origin").length,
      1,
    );
    assert.equal(
      result.events.filter((event) => event.sessionId === "fork").length,
      1,
    );
    assert.equal(
      result.events.find((event) => event.sessionId === "legacy")?.entryId,
      null,
    );
    assert.equal(await readFile(original.path, "utf8"), original.raw);
    assert.deepEqual(await collectSkillUsage(directory), result);
    await writeFile(
      originalPath,
      `${original.raw}\n${JSON.stringify({ ...invocation, id: "another" })}`,
    );
    assert.equal((await collectSkillUsage(directory)).events.length, 5);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "broken.jsonl"), "null");
    assert.equal((await collectSkillUsage(directory)).errors.length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing optional sessions directory is an empty scan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-missing-"));
  try {
    assert.deepEqual(await collectSkillUsage(join(directory, "missing")), {
      events: [],
      errors: [],
      sessionsAnalyzed: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
