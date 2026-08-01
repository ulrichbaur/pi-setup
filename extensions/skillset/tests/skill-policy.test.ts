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

const { default: skillPolicy, parseSkillPolicyConfig } = await import(
  "../policy/policy.ts"
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
    filter: (prompt: string = systemPrompt) =>
      beforeAgentStart!(
        {
          systemPrompt: prompt,
          systemPromptOptions: context.getSystemPromptOptions(),
        },
        context,
      ),
    notifications,
  };
}

test("policy config parsing rejects non-string allowlist entries", () => {
  assert.throws(
    () => parseSkillPolicyConfig({ allowAutoInvocation: ["alpha", 7] }),
    /allowAutoInvocation must be an array of skill names/,
  );
});

test("hides every skill by default while preserving the rest of the prompt", async () => {
  const fake = fakePi();

  const result = await fake.filter();

  assert.equal(result.systemPrompt, "Before\nAfter");
});

test("the interactive editor saves a private policy used by sessions", async () => {
  await rm(agentDirectory, { recursive: true, force: true });
  const fake = fakePi({
    mode: "tui",
    menuInputs: [["\r", "\x1b"]],
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

test("warns once per session when loaded skills have no recognizable prompt block", async () => {
  const fake = fakePi();
  const broken = "Before\n<skills>alpha</skills>\nAfter";

  const stderr: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message: string) => stderr.push(message);
  try {
    const result = await fake.filter(broken);

    // Headless runs have a no-op notify; the error must reach stderr too.
    assert.equal(stderr.length, 1);
    assert.match(stderr[0]!, /no <available_skills> block was found/);

    // Fail closed: the original prompt stays, an in-band countermand is added.
    assert.match(result.systemPrompt, /<skills>alpha<\/skills>/);
    assert.match(result.systemPrompt, /Do not invoke any skill on your own/);
    assert.match(
      fake.notifications[0][0],
      /no <available_skills> block was found/,
    );
    assert.match(fake.notifications[0][0], /auto-invocation is disabled/);
    assert.equal(fake.notifications[0][1], "error");

    // Repeated broken prompts stay quiet but keep the countermand;
    // a recovery re-arms the warning.
    const repeat = await fake.filter(broken);
    assert.match(repeat.systemPrompt, /Do not invoke any skill on your own/);
    assert.equal(fake.notifications.length, 1);
    await fake.filter();
    await fake.filter(broken);
    assert.equal(fake.notifications.length, 2);
    assert.equal(stderr.length, 2);
  } finally {
    console.error = originalConsoleError;
  }
});

test("malformed policy fails closed and notifies the user", async () => {
  await writeFile(policyFile, JSON.stringify({ allowAutoInvocation: "alpha" }));
  const fake = fakePi();

  const stderr: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message: string) => stderr.push(message);
  let result: any;
  try {
    result = await fake.filter();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(result.systemPrompt, "Before\nAfter");
  assert.match(
    fake.notifications[0][0],
    /allowAutoInvocation must be an array/,
  );
  assert.equal(fake.notifications[0][1], "error");
  assert.equal(stderr.length, 1);
  assert.match(stderr[0]!, /allowAutoInvocation must be an array/);
});

test("allowed skills that are no longer loaded stay editable in the menu", async () => {
  await writeFile(
    policyFile,
    JSON.stringify({ allowAutoInvocation: ["ghost"] }),
  );
  const arrowDown = `${String.fromCharCode(27)}[B`;
  // The menu lists loaded skills first (alpha, beta), then orphaned
  // allowlist entries; two downs reach ghost, enter revokes it.
  const fake = fakePi({
    mode: "tui",
    menuInputs: [[arrowDown, arrowDown, "\r", String.fromCharCode(27)]],
  });

  await fake.command("");

  assert.deepEqual(JSON.parse(await readFile(policyFile, "utf8")), {
    allowAutoInvocation: [],
  });
  assert.match(fake.notifications[0][0], /Saved skill policy/);
});
