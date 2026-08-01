import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  aggregateSkillUsage,
  deduplicateSkillUsageEvents,
  frecencyWeight,
} from "../history/aggregate.ts";
import { extractSkillUsageEvents } from "../history/extract.ts";
import type { SkillUsageEvent } from "../history/types.ts";

function skill(name: string, filePath: string): Skill {
  return {
    name,
    filePath,
    baseDir: join(filePath, ".."),
    description: name,
  } as Skill;
}

function baseEntry(type: string, id: string) {
  return { type, id, parentId: null, timestamp: "2026-01-02T03:04:05Z" };
}

function invocation(partial: Partial<SkillUsageEvent> = {}): SkillUsageEvent {
  return {
    skillName: "alpha",
    project: "/project",
    timestamp: 100,
    sourceId: "one",
    ...partial,
  };
}

test("extracts native skill invocations only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-usage-"));
  const skillDirectory = join(directory, "alpha");
  const filePath = join(skillDirectory, "SKILL.md");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(filePath, "# Alpha\n");

  try {
    const events = await extractSkillUsageEvents({
      entries: [
        {
          ...baseEntry("custom_message", "palette"),
          customType: "skill-palette",
          content: "legacy rendering",
          details: { skillName: "alpha", skillPath: filePath },
        },
        {
          ...baseEntry("message", "native"),
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `<skill name="alpha" location="${filePath}">body</skill>`,
              },
            ],
          },
        },
        {
          ...baseEntry("message", "assistant"),
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "read",
                name: "read",
                arguments: { path: filePath },
              },
            ],
          },
        },
        {
          ...baseEntry("message", "result"),
          message: {
            role: "toolResult",
            toolCallId: "read",
            toolName: "read",
            content: [],
            isError: false,
          },
        },
      ] as any,
      skillNames: new Set(["alpha"]),
      project: directory,
    });

    assert.deepEqual(
      events.map((event) => event.sourceId),
      ["native"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects expansions for skills outside the loaded inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-usage-"));
  const filePath = join(directory, "SKILL.md");
  await writeFile(filePath, "# Alpha\n");
  try {
    const events = await extractSkillUsageEvents({
      entries: [
        {
          ...baseEntry("message", "unknown"),
          message: {
            role: "user",
            content: `<skill name="unknown" location="${filePath}">body</skill>`,
          },
        },
      ] as any,
      skillNames: new Set(["alpha"]),
      project: directory,
    });
    assert.deepEqual(events, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deduplicates copied fork history", () => {
  const first = invocation();
  const copied = { ...first };
  const second = invocation({ timestamp: 200, sourceId: "two" });
  assert.equal(deduplicateSkillUsageEvents([first, copied, second]).length, 2);
  assert.equal(aggregateSkillUsage([first, copied, second])[0]?.invocations, 2);
});

test("dedup ignores the project so cross-project fork copies collapse", () => {
  const original = invocation({ project: "/proj/a" });
  const forkedIntoOtherProject = invocation({ project: "/proj/b" });
  assert.equal(
    deduplicateSkillUsageEvents([original, forkedIntoOtherProject]).length,
    1,
  );
});

test("aggregation includes loaded skills with no invocations", () => {
  const inventory = [
    skill("alpha", "/skills/alpha/SKILL.md"),
    skill("unused", "/skills/unused/SKILL.md"),
  ];
  assert.deepEqual(
    aggregateSkillUsage([invocation()], inventory).map(
      ({ skillName, invocations }) => ({ skillName, invocations }),
    ),
    [
      { skillName: "alpha", invocations: 1 },
      { skillName: "unused", invocations: 0 },
    ],
  );
});

test("frecency weight decays with a 30-day half-life and ignores future age", () => {
  const day = 86_400_000;
  const now = 1000 * day;
  assert.equal(frecencyWeight(now, now), 1);
  assert.equal(frecencyWeight(now - 30 * day, now), 0.5);
  assert.equal(frecencyWeight(now - 60 * day, now), 0.25);
  assert.equal(frecencyWeight(now + day, now), 1);
});

test("aggregation accumulates frecency across a skill's invocations", () => {
  const day = 86_400_000;
  const now = 1000 * day;
  const [summary] = aggregateSkillUsage(
    [
      invocation({ sourceId: "fresh", timestamp: now }),
      invocation({ sourceId: "halved", timestamp: now - 30 * day }),
    ],
    [],
    now,
  );
  assert.equal(summary?.frecency, 1.5);
});

test("aggregation returns rows in frecency-descending order by default", () => {
  const day = 86_400_000;
  const now = 1000 * day;
  const names = aggregateSkillUsage(
    [
      invocation({ sourceId: "old", timestamp: now - 200 * day }),
      invocation({ skillName: "zeta", sourceId: "new", timestamp: now }),
    ],
    [skill("unused", "/skills/unused/SKILL.md")],
    now,
  ).map((summary) => summary.skillName);
  assert.deepEqual(names, ["zeta", "alpha", "unused"]);
});
