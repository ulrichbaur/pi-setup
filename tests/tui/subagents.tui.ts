import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { type Script, startFakeModel, text } from "./fake-model.ts";

// Drives the real Pi TUI in a private tmux server against a fake model.
// Run it with `pnpm test:tui`; it needs tmux.

const REPO = resolve(import.meta.dirname, "..", "..");
const PI_CLI = join(
  REPO,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

// The parent sees a SCENARIO prompt; the test agent's system prompt carries
// ROLE: tester, and its task names what to do.
const script: Script = (messages) => {
  const system = text(messages.find((m) => m.role === "system")?.content);
  const users = messages
    .filter((m) => m.role === "user")
    .map((m) => text(m.content));
  const last = messages.at(-1);
  const lastText = text(last?.content);

  if (system.includes("ROLE: tester")) {
    const task = users[0] ?? "";
    if (task.includes("TASK ask")) {
      // A resumed session ends with the parent's answer.
      return users.slice(1).some((user) => user.includes("blue"))
        ? { text: "Tester chose blue" }
        : { tool: "ask_parent", args: { question: "Which color?" } };
    }
    if (task.includes("TASK delete")) {
      if (last?.role !== "tool") {
        return { tool: "safe_bash", args: { command: "rm notes.txt" } };
      }
      return {
        text: lastText.includes("blocked")
          ? "Tester was blocked"
          : "Tester deleted the file",
      };
    }
    if (last?.role === "tool") return { text: "Tester found the files" };
    return { tool: "ls", args: { path: "." } };
  }

  if (lastText.includes("Background subagent result")) {
    return { text: "Parent got the result" };
  }
  const scenario = [...users]
    .reverse()
    .find((user) => user.includes("SCENARIO"));
  if (last?.role === "tool") {
    const asked = /The subagent asks: .*\n.*session (tester-[0-9a-f]{8})/.exec(
      lastText,
    );
    if (asked) {
      return { tool: "subagent", args: { session: asked[1], task: "blue" } };
    }
    if (scenario?.includes("block")) return { text: "Parent waits" };
    return {
      text: scenario?.includes("ask") ? "Parent done asking" : "Parent done",
    };
  }
  if (scenario?.includes("foreground")) {
    return { tool: "subagent", args: { agent: "tester", task: "TASK list" } };
  }
  if (scenario?.includes("ask")) {
    return { tool: "subagent", args: { agent: "tester", task: "TASK ask" } };
  }
  if (scenario?.includes("block")) {
    return {
      tool: "subagent",
      args: { agent: "tester", task: "TASK delete", background: true },
    };
  }
  return { text: "Nothing to do" };
};

let root = "";
// The socket lives in the test's folder, so cleanup removes it too.
let socket = "";
let server: Server | undefined;

const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-p", "-t", "pi");
const type = (value: string) => tmux("send-keys", "-t", "pi", "-l", value);
const press = (...keys: string[]) => tmux("send-keys", "-t", "pi", ...keys);

async function waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = screen();
    if (pattern.test(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${pattern}. Screen:\n${last}`);
}

before(async () => {
  if (!hasTmux) return;
  root = mkdtempSync(join(tmpdir(), "pi-setup-tui-"));
  socket = join(root, "tmux.sock");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(project, "notes.txt"), "a file to list\n");

  const fake = await startFakeModel(script);
  server = fake.server;
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          api: "openai-completions",
          apiKey: "fake",
          models: [
            {
              id: "fake-model",
              contextWindow: 100_000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fake",
      defaultModel: "fake-model",
      quietStartup: true,
    }),
  );
  writeFileSync(
    join(agentDir, "agents", "tester.md"),
    "---\nname: tester\ndescription: scripted test agent\ntools: ls, ask_parent, safe_bash\n---\nROLE: tester\n",
  );
  const config = join(root, "tmux.conf");
  writeFileSync(
    config,
    "set -g extended-keys on\nset -g extended-keys-format csi-u\nset -sg escape-time 0\n",
  );

  // The agent directory is set inside the command, because the shell that
  // tmux starts may set its own from the user's profile.
  const command = [
    "env",
    `PI_CODING_AGENT_DIR=${agentDir}`,
    process.execPath,
    PI_CLI,
    "--no-skills",
    "--no-extensions",
    "--extension",
    join(REPO, "extensions/subagents/index.ts"),
    "--extension",
    join(REPO, "extensions/pi-statusline/index.ts"),
  ].join(" ");
  tmux(
    "-f",
    config,
    "new-session",
    "-d",
    "-s",
    "pi",
    "-x",
    "120",
    "-y",
    "40",
    "-c",
    project,
    command,
  );
  await waitFor(/fake-model/);
});

after(() => {
  if (!hasTmux) return;
  spawnSync("tmux", ["-S", socket, "kill-server"]);
  server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const skip = hasTmux ? false : "tmux is not installed";

test("a foreground run shows its result, transcript, and cost", {
  skip,
}, async () => {
  type("SCENARIO foreground");
  press("Enter");
  const done = await waitFor(/Parent done/);
  assert.match(done, /✓ tester/);
  assert.match(done, /Tester found the files/);
  assert.match(done, /sub \$0\.\d+/);

  press("C-o");
  const expanded = await waitFor(/Work in it yourself: \/agents open tester-/);
  assert.match(expanded, /Task: TASK list/);
  press("C-o");
  await waitFor(/^(?![\s\S]*Work in it yourself)/);
});

test("a subagent asks the parent, which resumes it with the answer", {
  skip,
}, async () => {
  type("SCENARIO ask");
  press("Enter");
  const done = await waitFor(/Parent done asking/);
  assert.match(done, /\? Asks the parent: Which color\?/);
  assert.match(done, /continues tester-/);
  assert.match(done, /Tester chose blue/);
  assert.doesNotMatch(done, /waiting for your answer/);
});

test("a background run's risky command is blocked", { skip }, async () => {
  type("SCENARIO block");
  press("Enter");
  await waitFor(/Parent waits/);
  await waitFor(/Background subagent finished/);
  const final = await waitFor(/Parent got the result/);
  assert.match(final, /Tester was blocked/);
  assert.equal(existsSync(join(root, "project", "notes.txt")), true);

  type("/agents");
  press("Enter");
  const list = await waitFor(/Subagents \(4\)/);
  assert.match(list, /tester-\w+ · completed/);
  press("Escape");
  await waitFor(/^(?![\s\S]*Subagents \(4\))/);
});
