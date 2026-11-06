import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const REPO = resolve(import.meta.dirname, "..", "..");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
let root = "";
let socket = "";
const tmux = (...args: string[]) =>
  execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
const screen = () => tmux("capture-pane", "-p", "-t", "files");
const type = (value: string) => tmux("send-keys", "-t", "files", "-l", value);
const press = (...keys: string[]) => tmux("send-keys", "-t", "files", ...keys);
async function waitFor(pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 15_000;
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
  root = mkdtempSync(join(tmpdir(), "pi-files-tui-"));
  socket = join(root, "tmux.sock");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  writeFileSync(join(project, "alpha.ts"), "alpha\n");
  writeFileSync(join(project, "beta.ts"), "beta\n");
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "fake",
          models: [{ id: "fake-model", contextWindow: 100_000 }],
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
  const config = join(root, "tmux.conf");
  writeFileSync(
    config,
    "set -g extended-keys on\nset -g extended-keys-format csi-u\nset -sg escape-time 0\n",
  );
  const command = [
    "env",
    `PI_CODING_AGENT_DIR=${agentDir}`,
    process.execPath,
    join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--no-skills",
    "--no-extensions",
    "--extension",
    join(REPO, "extensions/files/index.ts"),
  ].join(" ");
  tmux(
    "-f",
    config,
    "new-session",
    "-d",
    "-s",
    "files",
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
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Alt+O opens a fresh multi-file picker, confirms into the draft, and cancels without edits", {
  skip: hasTmux ? false : "tmux is not installed",
}, async () => {
  type("Draft remains");
  press("M-o");
  await waitFor(/Select files \(0 selected\)/);
  press("Tab");
  assert.match(await waitFor(/1 selected/), /\[x\] alpha.ts/);
  type("beta");
  await waitFor(/→ \[ \] beta.ts/);
  press("Tab");
  assert.match(await waitFor(/2 selected/), /\[x\] beta.ts/);
  press("Enter");
  const confirmed = await waitFor(/Draft remains @alpha.ts @beta.ts/);
  assert.doesNotMatch(confirmed, /Select files/);
  press("M-o");
  const reopened = await waitFor(/Select files \(0 selected\)/);
  assert.doesNotMatch(reopened, /\[x\]/);
  press("Tab", "Escape");
  const cancelled = await waitFor(/Draft remains @alpha.ts @beta.ts/);
  assert.doesNotMatch(cancelled, /Select files/);
  press("M-o");
  await waitFor(/Select files \(0 selected\)/);
  press("Down", "Enter");
  await waitFor(/Draft remains @alpha.ts @beta.ts @beta.ts/);
});
