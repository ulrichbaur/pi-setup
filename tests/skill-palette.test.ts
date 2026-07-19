import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import skillPalette, {
  buildSkillBlock,
} from "../extensions/skill-palette/index.ts";
import { showSkillPalette } from "../extensions/skill-palette/menu.ts";

function matchesBinding(data: string, binding: string): boolean {
  const keys: Record<string, string[]> = {
    "tui.select.up": ["\u001b[A"],
    "tui.select.down": ["\u001b[B"],
    "tui.select.confirm": ["\r", "\n"],
    "tui.select.cancel": ["\u001b", "\u0003"],
  };
  return keys[binding]?.includes(data) ?? false;
}

function makeSkill(name: string, filePath: string): Skill {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: join(filePath, ".."),
    disableModelInvocation: false,
    sourceInfo: { source: "test" },
  } as Skill;
}

test("formats the selected skill like Pi's native expansion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-palette-"));
  const filePath = join(directory, "SKILL.md");
  await writeFile(
    filePath,
    "---\nname: filtered\ndescription: test\n---\n\n# Instructions\nDo it.\n",
  );

  try {
    assert.equal(
      await buildSkillBlock(makeSkill("filtered", filePath)),
      `<skill name="filtered" location="${filePath}">\nReferences are relative to ${directory}.\n\n# Instructions\nDo it.\n</skill>`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("typing in the palette filters skill names and descriptions", async () => {
  const alpha = makeSkill("alpha", "/tmp/alpha.md");
  alpha.description = "frontend deployment";
  const beta = makeSkill("beta", "/tmp/beta.md");
  beta.description = "database migration";
  let filteredRender = "";

  const selected = await showSkillPalette([alpha, beta], null, {
    ui: {
      custom: (build: any) =>
        new Promise((resolve) => {
          const component = build(
            { requestRender() {} },
            {
              fg: (_color: string, text: string) => text,
              bold: (text: string) => text,
            },
            { matches: matchesBinding },
            resolve,
          );
          for (const character of "database") {
            component.handleInput(character);
          }
          filteredRender = component.render(100).join("\n");
          component.handleInput("\r");
        }),
    },
  } as any);

  assert.equal(selected, beta);
  assert.match(filteredRender, /beta/);
  assert.doesNotMatch(filteredRender, /alpha/);
});

test("the palette only offers skills in Pi's filtered loaded list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skill-palette-"));
  const allowedPath = join(directory, "allowed.md");
  await writeFile(
    allowedPath,
    "---\ndescription: allowed\n---\nAllowed body\n",
  );
  const allowed = makeSkill("allowed", allowedPath);

  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  let beforeStart: ((event: any, ctx: any) => Promise<any>) | undefined;
  let rendered = "";
  const notifications: unknown[][] = [];
  const context = {
    mode: "tui",
    getSystemPromptOptions: () => ({ skills: [allowed] }),
    ui: {
      notify: (...args: unknown[]) => notifications.push(args),
      setStatus() {},
      setWidget() {},
      custom: (build: any) =>
        new Promise((resolve) => {
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          const component = build(
            { requestRender() {} },
            theme,
            { matches: matchesBinding },
            resolve,
          );
          rendered = component.render(100).join("\n");
          component.handleInput("\r");
        }),
    },
  };
  const pi = {
    registerMessageRenderer() {},
    registerCommand(_name: string, value: any) {
      command = value.handler;
    },
    on(name: string, handler: any) {
      if (name === "before_agent_start") beforeStart = handler;
    },
  };

  try {
    skillPalette(pi as any);
    await command!("", context);
    const result = await beforeStart!({}, context);

    assert.match(rendered, /allowed/);
    assert.doesNotMatch(rendered, /unfiltered/);
    assert.match(result.message.content, /<skill name="allowed"/);
    assert.match(result.message.content, /Allowed body/);
    assert.deepEqual(notifications[0], ["Skill queued: allowed", "info"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
