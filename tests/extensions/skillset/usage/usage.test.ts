import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import skillUsage, {
  exportSkillUsage,
} from "../../../../extensions/skillset/usage/usage.ts";

test("exports immutable unique timestamped reports beneath the configured agent directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-export-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await mkdir(join(directory, "sessions"));
    await writeFile(join(directory, "sessions", "bad.jsonl"), "broken");
    let handler: any;
    skillUsage({
      registerCommand(_name: string, command: any) {
        handler = command.handler;
      },
      on() {
        assert.fail("no background hooks");
      },
    } as any);
    const notifications: Array<[string, string]> = [];
    await handler("", {
      hasUI: true,
      ui: {
        notify(text: string, level: string) {
          notifications.push([text, level]);
        },
      },
    });
    assert.equal(notifications[0]?.[1], "warning");
    assert.match(notifications[0]![0], /0 sessions analyzed; 1 scan errors/);
    const now = new Date("2026-01-02T03:04:05Z");
    const first = await exportSkillUsage(directory, now);
    const second = await exportSkillUsage(directory, now);
    assert.notEqual(first.path, second.path);
    assert.equal(first.report.schemaVersion, 1);
    assert.equal(first.report.generatedAt, now.toISOString());
    assert.deepEqual(
      JSON.parse(await readFile(first.path, "utf8")),
      first.report,
    );
    assert.match(
      first.path,
      /skill-usage\/2026-01-02T03-04-05\.000Z-.*\.json$/,
    );
    assert.equal((await readdir(join(directory, "skill-usage"))).length, 3);
    assert.ok(notifications[0]![0].includes(join(directory, "skill-usage")));
    await handler("extra", {
      hasUI: true,
      ui: {
        notify(text: string) {
          assert.match(text, /no arguments/);
        },
      },
    });
    assert.equal((await readdir(join(directory, "skill-usage"))).length, 3);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("write failure includes the full destination path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-export-fail-"));
  try {
    await writeFile(join(directory, "skill-usage"), "not a directory");
    await assert.rejects(exportSkillUsage(directory), (error: Error) =>
      error.message.includes(join(directory, "skill-usage")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
