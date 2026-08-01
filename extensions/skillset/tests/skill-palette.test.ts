import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Isolate session-history scanning from the developer's real agent state.
const home = await mkdtemp(join(tmpdir(), "skill-palette-test-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");

const { default: skillPalette, orderSkillsByUsage } = await import(
  "../palette/palette.ts"
);
const { showSkillPalette } = await import("../palette/palette-menu.ts");
type Skill = Parameters<typeof showSkillPalette>[0][number];

after(async () => {
  await rm(home, { recursive: true, force: true });
});

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

test("typing in the palette filters skill names and descriptions", async () => {
  const alpha = makeSkill("alpha", "/tmp/alpha.md");
  alpha.description = "frontend deployment";
  const beta = makeSkill("beta", "/tmp/beta.md");
  beta.description = "database migration";
  let filteredRender = "";

  const selected = await showSkillPalette([alpha, beta], {
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

test("usage rows order the palette while unknown names are dropped", () => {
  const alpha = makeSkill("alpha", "/tmp/alpha.md");
  const beta = makeSkill("beta", "/tmp/beta.md");

  const ordered = orderSkillsByUsage(
    [alpha, beta],
    [{ skillName: "beta" }, { skillName: "removed" }, { skillName: "alpha" }],
  );

  assert.deepEqual(
    ordered.map((skill) => skill.name),
    ["beta", "alpha"],
  );
});

test("the palette prefills Pi's native skill command", async () => {
  const allowed = makeSkill("allowed", "/tmp/allowed/SKILL.md");
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  let editorText = "";
  const context = {
    mode: "tui",
    getSystemPromptOptions: () => ({ skills: [allowed] }),
    ui: {
      notify() {},
      setEditorText: (text: string) => {
        editorText = text;
      },
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
          component.handleInput("\r");
        }),
    },
  };
  const pi = {
    registerCommand(_name: string, value: any) {
      command = value.handler;
    },
    on() {},
  };

  skillPalette(pi as any);
  await command!("", context);

  assert.equal(editorText, "/skill:allowed ");
});

test("usage history orders the palette by frecency before it opens", async () => {
  const sessionDirectory = join(home, ".pi", "agent", "sessions", "--proj--");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(sessionDirectory, "history.jsonl"),
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "history",
      timestamp: "2026-07-01T00:00:00Z",
      cwd: "/proj",
    })}\n${JSON.stringify({
      type: "message",
      id: "h1",
      parentId: null,
      timestamp: "2026-07-01T00:00:00Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: '<skill name="beta" location="/tmp/beta.md">body</skill>',
          },
        ],
      },
    })}\n`,
  );

  const alpha = makeSkill("alpha", "/tmp/alpha.md");
  const beta = makeSkill("beta", "/tmp/beta.md");
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  let editorText = "";
  let initialRender: string[] = [];
  const context = {
    mode: "tui",
    getSystemPromptOptions: () => ({ skills: [alpha, beta] }),
    ui: {
      notify() {},
      setEditorText: (text: string) => {
        editorText = text;
      },
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
          initialRender = component.render(100);
          component.handleInput("\r");
        }),
    },
  };
  const pi = {
    registerCommand(_name: string, value: any) {
      command = value.handler;
    },
    on() {},
  };

  skillPalette(pi as any);
  await command!("", context);

  const rendered = initialRender.join("\n");
  const betaIndex = rendered.indexOf("beta");
  const alphaIndex = rendered.indexOf("alpha");
  assert.ok(betaIndex >= 0 && alphaIndex >= 0);
  assert.ok(betaIndex < alphaIndex, "invoked skill should be listed first");
  assert.equal(editorText, "/skill:beta ");
});

test("a hanging history scan cannot delay the palette beyond its timeout", {
  timeout: 2000,
}, async () => {
  const { orderSkillsByFrecency } = await import("../palette/palette.ts");
  const alpha = makeSkill("alpha", "/tmp/alpha.md");
  const beta = makeSkill("beta", "/tmp/beta.md");

  const ordered = await orderSkillsByFrecency(
    [alpha, beta],
    () => new Promise(() => {}),
  );

  assert.deepEqual(
    ordered.map((skill) => skill.name),
    ["alpha", "beta"],
  );
});

test("a timed-out scan reuses the order of the last completed scan", {
  timeout: 2000,
}, async () => {
  const { orderSkillsByFrecency } = await import("../palette/palette.ts");
  const alpha = makeSkill("alpha", "/tmp/alpha.md");
  const beta = makeSkill("beta", "/tmp/beta.md");
  const skills = [alpha, beta];
  const cache = {};

  const events = [
    {
      skillName: "beta",
      project: "/proj",
      timestamp: Date.now(),
      sourceId: "b1",
    },
  ];
  await orderSkillsByFrecency(
    skills,
    () => Promise.resolve({ events, errors: [] }),
    cache,
  );

  const ordered = await orderSkillsByFrecency(
    skills,
    () => new Promise(() => {}),
    cache,
  );

  assert.deepEqual(
    ordered.map((skill) => skill.name),
    ["beta", "alpha"],
  );
});

test("a failing history scan falls back to the given skill order", async () => {
  const { orderSkillsByFrecency } = await import("../palette/palette.ts");
  const alpha = makeSkill("alpha", "/tmp/alpha.md");
  const beta = makeSkill("beta", "/tmp/beta.md");

  const ordered = await orderSkillsByFrecency([alpha, beta], () =>
    Promise.reject(new Error("history scan broke")),
  );

  assert.deepEqual(
    ordered.map((skill) => skill.name),
    ["alpha", "beta"],
  );
});
