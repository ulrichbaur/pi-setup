import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  jobDir,
  readJob,
  saveJob,
  startJob,
  stopJob,
} from "../../extensions/background-tasks/runner.ts";
import { withTempDir } from "../helpers.ts";
import { startFakeModel, text } from "./fake-model.ts";

const repo = resolve(import.meta.dirname, "../..");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

test("/tasks manages jobs and announces results without interrupting tools", {
  skip: !hasTmux || process.platform === "win32",
  timeout: 35_000,
}, async () => {
  await withTempDir("pi-bg-tui-", async (root) => {
    const project = join(root, "project");
    const agent = join(root, "agent");
    const sessions = join(root, "sessions");
    const socket = join(root, "tmux.sock");
    for (const dir of [project, agent, sessions]) mkdirSync(dir);
    let modelCalls = 0;
    const { server, port } = await startFakeModel((messages) => {
      modelCalls++;
      const last = messages.at(-1);
      if (
        last?.role === "user" &&
        text(last.content) === "Run the foreground check"
      ) {
        return {
          tool: "bash",
          args: {
            command:
              "touch tool-started; while [ ! -e tool-release ]; do sleep 0.05; done; printf 'foreground check passed\u005cn'",
            timeout: 15,
          },
        };
      }
      const content = (phrase: string) =>
        messages.some((message) => text(message.content).includes(phrase));
      if (
        content("(Steer case) completed") &&
        content("foreground check passed")
      )
        return { text: "Steering arrived after the tool finished" };
      if (content("(Idle case) completed"))
        return { text: "Completion woke the idle agent" };
      return { text: "Unexpected model call" };
    });
    writeFileSync(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "fake",
            models: [{ id: "fake-model", contextWindow: 100_000 }],
          },
        },
      }),
    );
    const session = SessionManager.create(project, sessions);
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile);
    writeFileSync(sessionFile, `${JSON.stringify(session.getHeader())}\n`);
    const owner = session.getSessionId();
    const store = join(agent, "background-tasks");
    const job = await startJob(store, owner, {
      cwd: project,
      label: "Live job",
      command: [
        "i=1; while [ $i -le 40 ]; do printf 'line-%s\\n' \"$i\"; i=$((i+1)); done; while [ ! -e more ]; do sleep 0.05; done; printf 'live update\\n'; sleep 60",
        ...Array.from({ length: 20 }, (_, i) => `# command comment ${i + 1}`),
      ].join("\n"),
      timeoutMs: 30_000,
    });
    const liveDir = jobDir(store, owner, job.id);
    const pastId = "00112233-4455-6677-8899-aabbccddeeff";
    const pastDir = jobDir(store, owner, pastId);
    mkdirSync(pastDir);
    saveJob(pastDir, {
      ...job,
      id: pastId,
      label: "Past job",
      command: "printf 'past output\\n'\nexit 2",
      state: "exited",
      exitCode: 2,
      finishedAt: job.createdAt,
    });
    writeFileSync(
      join(pastDir, "output.log"),
      `past output\n${"long ".repeat(25)}wrapped tail\n`,
    );
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
    const press = (...keys: string[]) =>
      tmux("send-keys", "-t", "tasks", ...keys);
    const command = (value: string) => {
      tmux("send-keys", "-t", "tasks", "-l", value);
      press("Enter");
    };
    async function screen(pattern: RegExp): Promise<string> {
      const until = Date.now() + 8_000;
      let output = "";
      while (Date.now() < until) {
        output = tmux("capture-pane", "-p", "-t", "tasks").replace(
          /^.*?│ (.*?) +│.*$/gm,
          "$1",
        );
        if (pattern.test(output)) return output;
        await delay(75);
      }
      throw new Error(`Could not find ${pattern}:\n${output}`);
    }
    try {
      tmux(
        "new-session",
        "-d",
        "-s",
        "tasks",
        "-x",
        "120",
        "-y",
        "40",
        "-c",
        project,
        "env",
        `PI_CODING_AGENT_DIR=${agent}`,
        "PI_SKIP_VERSION_CHECK=1",
        process.execPath,
        join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--provider",
        "fake",
        "--model",
        "fake-model",
        "--no-skills",
        "--no-extensions",
        "--extension",
        join(repo, "extensions/background-tasks/index.ts"),
        "--extension",
        join(repo, "extensions/pi-statusline/index.ts"),
        "--session",
        sessionFile,
      );
      await screen(/Details: \/tasks 00112\s*$/m);
      await screen(/Tasks: 1 running · 1 unreviewed \(1 failed\)/);
      assert.equal(modelCalls, 0);
      tmux("send-keys", "-t", "tasks", "-l", "Unsubmitted draft");
      press("M-t");
      const list = await screen(/Failed \(exit 2\).*unreviewed.*Past job/);
      assert.match(list, /> [0-9a-f-]{5,36} · Running.*Live job[\s\S]*History/);
      assert.equal(existsSync(join(pastDir, "reviewed")), false);
      press("Enter");
      const tail = await screen(/^40 {2}line-40$/m);
      assert.match(tail, /Output \(following\) · lines 29–40 of 40/);
      assert.ok(tail.includes(`Log: …/${owner}/${job.id}/output.log`));
      const frame = (output: string) => {
        const lines = output.split("\n");
        const top = lines.findIndex((line) => /╭─+╮/.test(line));
        const bottom = lines.findIndex((line) => /╰─+╯/.test(line));
        assert.ok(top >= 0 && bottom > top, output);
        return [lines[top].match(/╭─+╮/)?.[0], bottom - top + 1];
      };
      assert.deepEqual(frame(tail), frame(list));
      assert.equal(frame(tail)[1], 21);
      assert.deepEqual(
        tail.match(/^\d+ {2}line-\d+$/gm),
        Array.from({ length: 12 }, (_, i) => `${i + 29}  line-${i + 29}`),
      );
      press("u");
      await screen(/Output \(paused\) · lines 17–28 of 40/);
      press("c");
      const fullCommand = await screen(/^# command comment 1$/m);
      assert.deepEqual(frame(fullCommand), frame(tail));
      assert.match(fullCommand, /printf 'live update\\n'; sleep 60/);
      assert.match(fullCommand, /Running.*Task/);
      assert.doesNotMatch(fullCommand, /Output \(paused\)/);
      assert.doesNotMatch(fullCommand, /^# command comment 20$/m);
      press("d");
      await screen(/^# command comment 20$/m);
      press("c");
      await screen(/Output \(paused\) · lines 17–28 of 40/);
      writeFileSync(join(project, "more"), "");
      assert.doesNotMatch(await screen(/Output \(paused\)/), /live update/);
      press("/");
      for (const key of "line-") press(key);
      await screen(/Search: > line-/);
      await screen(/Output \(paused\) · lines 17–28 of 40/);
      press("Escape");
      await screen(
        /^(?![\s\S]*Search: >)[\s\S]*Output \(paused\) · lines 17–28 of 40/,
      );
      press("/");
      for (const key of "line-") press(key);
      await screen(/^Search: > line-$/m);
      press("Enter");
      await screen(/Match on line 17\b/);
      press("n");
      await screen(/Match on line 18\b/);
      press("N");
      await screen(/Match on line 17\b/);
      press("/");
      for (const key of "line-5") press(key);
      press("Enter");
      await screen(/Match on line 5\b/);
      press("?");
      for (const key of "line-2") press(key);
      await screen(/Search backward: > line-2/);
      press("Enter");
      await screen(/Match on line 2\b/);
      press("n");
      await screen(/Match on line 20\b/);
      press("N");
      await screen(/Match on line 2\b/);
      press("?");
      for (const key of "line-4") press(key);
      press("Enter");
      await screen(/Match on line 40\b/);
      press("End");
      await screen(/^41 {2}live update$/m);
      press("x");
      await screen(/Stopping/);
      await screen(/Stopped/);
      press("Escape");
      await screen(/^(?![\s\S]*╭─+╮)[\s\S]*Unsubmitted draft/);
      press("C-u");
      press("/", "t", "a", "s", "k", "s", "Space");
      await screen(/00112\s+Failed \(exit 2\) · Past job/);
      press("0", "0", "1");
      await screen(/00112\s+Failed \(exit 2\) · Past job/);
      press("Tab");
      await screen(/\/tasks 00112/);
      press("Enter");
      const details = await screen(/^1 {2}past output$/m);
      assert.match(details, /Task 00112$/m);
      assert.doesNotMatch(details, /wrapped tail/);
      press("w");
      const wrapped = await screen(/^ {3}.*wrapped tail$/m);
      assert.match(wrapped, /Output \(following\) · lines 1–2 of 2/);
      press("w");
      const unwrapped = await screen(/w wrap/);
      assert.doesNotMatch(unwrapped, /wrapped tail/);
      press("c");
      const expanded = await screen(/^exit 2$/m);
      assert.match(expanded, /^1 {2}past output$/m);
      assert.equal(existsSync(join(pastDir, "reviewed")), true);
      await screen(/^(?![\s\S]*\d+ (?:running|unreviewed))[\s\S]*fake-model/);
      press("Escape");
      await screen(
        /^(?![\s\S]*╭─+╮)[\s\S]*Background task \(Live job\) stopped/,
      );
      assert.equal(modelCalls, 0);

      function complete(id: string, label: string): string {
        const dir = jobDir(store, owner, id);
        mkdirSync(dir);
        saveJob(dir, {
          ...job,
          id,
          label,
          state: "exited",
          exitCode: 0,
          finishedAt: new Date().toISOString(),
        });
        return dir;
      }
      complete("00112233-5455-6677-8899-aabbccddeeff", "Idle case");
      await screen(/Completion woke the idle agent/);
      assert.equal(modelCalls, 1);
      await screen(/Details: \/tasks 00112233-5\s*$/m);
      tmux("send-keys", "-t", "tasks", "-l", `/tasks ${pastId.slice(0, 5)}`);
      await screen(/00112233-4\s+Failed \(exit 2\) · Past job/);
      press("Escape", "Enter");
      await screen(/Multiple jobs match. Enter a longer job ID prefix\./);
      tmux("send-keys", "-t", "tasks", "-l", `/tasks ${pastId.slice(0, 10)}`);
      await screen(/00112233-4\s+Failed \(exit 2\) · Past job/);
      press("Tab", "Enter");
      await screen(/^1 {2}past output$/m);
      press("Escape");
      await screen(/^(?![\s\S]*╭─+╮)[\s\S]*fake-model/);
      command("Run the foreground check");
      const toolDeadline = Date.now() + 5_000;
      while (
        !existsSync(join(project, "tool-started")) &&
        Date.now() < toolDeadline
      )
        await delay(50);
      assert.ok(
        existsSync(join(project, "tool-started")),
        tmux("capture-pane", "-p", "-t", "tasks"),
      );
      const steerDir = complete(
        "20112233-4455-6677-8899-aabbccddeeff",
        "Steer case",
      );
      const noticeDeadline = Date.now() + 5_000;
      while (
        !existsSync(join(steerDir, "notified")) &&
        Date.now() < noticeDeadline
      )
        await delay(50);
      assert.equal(existsSync(join(steerDir, "notified")), true);
      assert.equal(modelCalls, 2);
      writeFileSync(join(project, "tool-release"), "");
      await screen(/Steering arrived after the tool finished/);
      assert.equal(modelCalls, 3);
    } finally {
      spawnSync("tmux", ["-S", socket, "kill-server"]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!readJob(liveDir).finishedAt) {
        await stopJob(liveDir);
        const until = Date.now() + 7_000;
        while (!readJob(liveDir).finishedAt && Date.now() < until)
          await delay(75);
      }
    }
  });
});
