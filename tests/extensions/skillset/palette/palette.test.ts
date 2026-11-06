import assert from "node:assert/strict";
import { test } from "node:test";
import skillPalette from "../../../../extensions/skillset/palette/palette.ts";

function skill(name: string, description = name) {
  return { name, description, filePath: `/missing/${name}/SKILL.md` };
}

async function open(query: string) {
  let handler: any;
  let editor = "";
  let rendered = "";
  skillPalette({
    registerCommand(_name: string, command: any) {
      handler = command.handler;
    },
    on() {
      assert.fail("palette must not register background hooks");
    },
  } as any);
  await handler("", {
    mode: "tui",
    getSystemPromptOptions: () => ({
      skills: [
        skill("zeta", "database migration"),
        skill("alpha", "frontend deployment"),
      ],
    }),
    ui: {
      notify() {
        assert.fail("unexpected notification");
      },
      setEditorText(text: string) {
        editor = text;
      },
      custom: (build: any) =>
        new Promise((done) => {
          const component = build(
            { requestRender() {} },
            {
              fg: (_: string, text: string) => text,
              bold: (text: string) => text,
            },
            {
              matches: (data: string, binding: string) =>
                binding === "tui.select.confirm" && data === "\r",
            },
            done,
          );
          for (const character of query) component.handleInput(character);
          rendered = component.render(100).join("\n");
          component.handleInput("\r");
        }),
    },
  });
  return { editor, rendered };
}

test("picker uses alphabetical loaded skills and prefills native invocation without background hooks", async () => {
  const { editor, rendered } = await open("");
  assert.equal(editor, "/skill:alpha ");
  assert.ok(rendered.indexOf("alpha") < rendered.indexOf("zeta"));
});

test("picker searches descriptions", async () => {
  const { editor, rendered } = await open("database");
  assert.equal(editor, "/skill:zeta ");
  assert.doesNotMatch(rendered, /alpha/);
});
