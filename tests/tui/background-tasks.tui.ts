import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type Job,
  jobDir,
  readJob,
  saveJob,
} from "../../extensions/background-work/tasks/runner.ts";
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
    const started: Record<string, string> = {};
    const jobs: Record<string, { label: string; command: string }> = {
      "Start the live job": {
        label: "Live job",
        command: [
          "i=1; while [ $i -le 40 ]; do printf 'line-%s\\n' \"$i\"; i=$((i+1)); done; while [ ! -e more ]; do sleep 0.05; done; printf 'live update\\n'; sleep 60",
          ...Array.from({ length: 20 }, (_, i) => `# command comment ${i + 1}`),
        ].join("\n"),
      },
      "Start the idle case": {
        label: "Idle case",
        command: "while [ ! -e idle-go ]; do sleep 0.05; done",
      },
      "Start the steer case": {
        label: "Steer case",
        command: "while [ ! -e steer-go ]; do sleep 0.05; done",
      },
    };
    const { server, port } = await startFakeModel((messages) => {
      modelCalls++;
      const last = messages.at(-1);
      const prompt = text(
        messages.findLast((message) => message.role === "user")?.content,
      );
      if (last?.role === "user" && jobs[prompt]) {
        return {
          tool: "task_start",
          args: { ...jobs[prompt], timeoutMs: 30_000 },
        };
      }
      if (last?.role === "tool" && jobs[prompt]) {
        const id = text(last.content).match(/background job (\S+)\./)?.[1];
        if (id) started[jobs[prompt].label] = id;
        return { text: `${jobs[prompt].label} started` };
      }
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
    const record = (id: string, fields: Partial<Job>): string => {
      const dir = jobDir(store, owner, id);
      mkdirSync(dir, { recursive: true });
      saveJob(dir, {
        id,
        command: "true",
        cwd: project,
        timeoutMs: 30_000,
        state: "exited",
        exitCode: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        ...fields,
      });
      return dir;
    };
    const pastId = "00112233-4455-6677-8899-aabbccddeeff";
    const pastDir = record(pastId, {
      label: "Past job",
      command: "printf 'past output\\n'\nexit 2",
      exitCode: 2,
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
        join(repo, "extensions/background-work/index.ts"),
        "--extension",
        join(repo, "extensions/pi-statusline/index.ts"),
        "--session",
        sessionFile,
      );
      // A finished job from an earlier run sends no notice.
      await screen(/fake-model/);
      assert.equal(modelCalls, 0);
      command("Start the live job");
      await screen(/Live job started/);
      await screen(/Tasks: 1 running(?! ·)/);
      const liveId = started["Live job"];
      assert.ok(liveId);
      assert.equal(modelCalls, 2);
      tmux("send-keys", "-t", "tasks", "-l", "Unsubmitted draft");
      press("M-t");
      // The worker may still be starting the shell when the list opens.
      const list = await screen(
        /> [0-9a-f-]{5,36} · Running.*Live job[\s\S]*History/,
      );
      assert.match(list, /Failed \(exit 2\) · [^·]+ · Past job/);
      press("Enter");
      const tail = await screen(/^40 {2}line-40$/m);
      assert.match(tail, /Output \(following\) · lines 29–40 of 40/);
      assert.ok(tail.includes(`Log: …/${owner}/${liveId}/output.log`));
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
      await screen(/^(?![\s\S]*\d+ running)[\s\S]*fake-model/);
      press("Escape");
      await screen(
        /^(?![\s\S]*╭─+╮)[\s\S]*Background task \(Live job\) stopped/,
      );
      // A requested stop does not wake the agent.
      assert.equal(modelCalls, 2);

      command("Start the idle case");
      await screen(/Idle case started/);
      assert.equal(modelCalls, 4);
      writeFileSync(join(project, "idle-go"), "");
      await screen(/Completion woke the idle agent/);
      assert.equal(modelCalls, 5);
      await screen(/Background task \(Idle case\) completed · exit 0\./);

      // A second job with the same short prefix makes the prefix ambiguous.
      record("00112233-5455-6677-8899-aabbccddeeff", { label: "Other job" });
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
      command("Start the steer case");
      await screen(/Steer case started/);
      const steerDir = jobDir(store, owner, started["Steer case"]);
      assert.equal(modelCalls, 7);
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
      // The steer case ends while the foreground tool still runs.
      writeFileSync(join(project, "steer-go"), "");
      const endDeadline = Date.now() + 5_000;
      while (!readJob(steerDir).finishedAt && Date.now() < endDeadline)
        await delay(50);
      assert.equal(readJob(steerDir).state, "exited");
      await delay(300);
      assert.equal(modelCalls, 8);
      writeFileSync(join(project, "tool-release"), "");
      await screen(/Steering arrived after the tool finished/);
      assert.equal(modelCalls, 9);
    } finally {
      // Pi dies with the tmux server, and its workers stop the jobs.
      spawnSync("tmux", ["-S", socket, "kill-server"]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
