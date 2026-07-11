import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "skill-policy-test-"));
const agentDirectory = join(home, ".pi", "agent");
const policyFile = join(agentDirectory, "skill-policy.json");
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDirectory;

const { default: skillPolicy } = await import(
  "../extensions/skill-policy/index.ts"
);

beforeEach(async () => {
  await mkdir(agentDirectory, { recursive: true });
  await rm(policyFile, { force: true });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

const systemPrompt = `Before
<available_skills>
  <skill><name>alpha</name><description>Alpha</description></skill>
  <skill><name>beta</name><description>Beta</description></skill>
</available_skills>
After`;

function fakePi(options: { mode?: string; menuInputs?: string[][] } = {}) {
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let beforeAgentStart: ((event: any, ctx: any) => Promise<any>) | undefined;
  const notifications: any[] = [];
  const context = {
    mode: options.mode,
    getSystemPromptOptions: () => ({
      skills: [
        { name: "beta", description: "Beta" },
        { name: "alpha", description: "Alpha" },
      ],
    }),
    ui: {
      notify: (...args: any[]) => notifications.push(args),
      custom: (build: any) =>
        new Promise((resolve) => {
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          const component = build(
            { requestRender() {} },
            theme,
            undefined,
            resolve,
          );
          for (const input of options.menuInputs?.shift() ?? []) {
            component.handleInput(input);
          }
        }),
    },
  };

  const pi = {
    registerCommand(_name: string, command: any) {
      commandHandler = command.handler;
    },
    on(name: string, handler: any) {
      if (name === "before_agent_start") beforeAgentStart = handler;
    },
  };

  skillPolicy(pi as any);
  return {
    command: (args: string) => commandHandler!(args, context),
    filter: () =>
      beforeAgentStart!(
        { systemPrompt, systemPromptOptions: context.getSystemPromptOptions() },
        context,
      ),
    notifications,
  };
}

test("hides every skill by default while preserving the rest of the prompt", async () => {
  const fake = fakePi();

  const result = await fake.filter();

  assert.equal(result.systemPrompt, "Before\nAfter");
});

test("the interactive editor saves a private policy used by sessions", async () => {
  await rm(agentDirectory, { recursive: true, force: true });
  const fake = fakePi({
    mode: "tui",
    menuInputs: [["\r"], ["\x1b[B", "\x1b[B", "\x1b[B", "\r"]],
  });

  await fake.command("");
  const result = await fake.filter();

  assert.deepEqual(JSON.parse(await readFile(policyFile, "utf8")), {
    allowAutoInvocation: ["alpha"],
  });
  assert.equal((await stat(policyFile)).mode & 0o777, 0o600);
  assert.match(result.systemPrompt, /<name>alpha<\/name>/);
  assert.doesNotMatch(result.systemPrompt, /<name>beta<\/name>/);
  assert.match(fake.notifications[0][0], /Saved skill policy/);
});

test("malformed policy fails closed and notifies the user", async () => {
  await writeFile(policyFile, JSON.stringify({ allowAutoInvocation: "alpha" }));
  const fake = fakePi();

  const result = await fake.filter();

  assert.equal(result.systemPrompt, "Before\nAfter");
  assert.match(
    fake.notifications[0][0],
    /allowAutoInvocation must be an array/,
  );
  assert.equal(fake.notifications[0][1], "error");
});
