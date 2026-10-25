import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const firstUser = text(messages.find((m) => m.role === "user")?.content);
  const last = messages.at(-1);
  const lastText = text(last?.content);

  if (system.includes("ROLE: tester")) {
    const asks = firstUser.includes("TASK ask");
    if (last?.role === "tool") {
      if (!asks) return { text: "Tester found the files" };
      return {
        text: lastText.includes("blue")
          ? "Tester chose blue"
          : "Tester got no answer",
      };
    }
    return asks
      ? {
          tool: "ask_user",
          args: { question: "Which color?", options: ["red", "blue"] },
        }
      : { tool: "ls", args: { path: "." } };
  }

  if (lastText.includes("Background subagent result")) {
    return { text: "Parent got the result" };
  }
  const scenario = messages
    .filter((m) => m.role === "user")
    .map((m) => text(m.content))
    .reverse()
    .find((content) => content.includes("SCENARIO"));
  if (last?.role === "tool") {
    return {
      text: scenario?.includes("question") ? "Parent continues" : "Parent done",
    };
  }
  if (scenario?.includes("foreground")) {
    return { tool: "subagent", args: { agent: "tester", task: "TASK list" } };
  }
  if (scenario?.includes("question")) {
    return {
      tool: "subagent",
      args: { agent: "tester", task: "TASK ask", background: true },
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
    "---\nname: tester\ndescription: scripted test agent\ntools: ls, ask_user\n---\nROLE: tester\n",
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

test("a background question is answered in /agents", { skip }, async () => {
  type("SCENARIO question");
  press("Enter");
  await waitFor(/Parent continues/);
  await waitFor(/is waiting for your answer/);

  type("/agents");
  press("Enter");
  const list = await waitFor(/Subagents \(2\)/);
  assert.match(list, /tester-\w+ · running .*waiting for your answer/);
  // The overlay stays within the 85% of rows it may use.
  const frame = list.split("\n").filter((line) => line.includes("─"));
  assert.ok(frame.length >= 2);

  press("Enter");
  await waitFor(/\? Which color\?/);
  press("Down");
  press("Enter");
  await waitFor(/Answered\./);
  // tmux would merge quick Escapes into one sequence; wait for each step.
  press("Escape");
  await waitFor(/Subagents \(2\)/);
  press("Escape");
  await waitFor(/^(?![\s\S]*Subagents \(2\))/);

  await waitFor(/Background subagent finished/);
  const final = await waitFor(/Parent got the result/);
  assert.match(final, /Tester chose blue/);
});
