import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLineSplitter,
  type DialogHandler,
  RpcChild,
  type RpcRecord,
} from "../../../extensions/subagents/rpc.ts";

const FAKE_PI = join(import.meta.dirname, "fake-pi.ts");

function startFake(mode: string): RpcChild {
  return new RpcChild(process.execPath, [FAKE_PI, mode], process.cwd());
}

test("the line splitter keeps Unicode separators and split characters", () => {
  const lines: string[] = [];
  const splitter = createLineSplitter((line) => lines.push(line));
  const bytes = Buffer.from('{"a":"x y"}\r\n{"b":"ä"}\n{"c":1}');
  const umlaut = bytes.indexOf(Buffer.from("ä"));
  splitter.write(bytes.subarray(0, umlaut + 1));
  splitter.write(bytes.subarray(umlaut + 1));
  splitter.end();
  assert.deepEqual(lines, ['{"a":"x y"}', '{"b":"ä"}', '{"c":1}']);
});

test("an RPC child answers commands, forwards events, and cancels dialogs", async () => {
  const child = startFake("complete");
  const records: RpcRecord[] = [];
  const settled = new Promise<void>((resolve) =>
    child.onRecord((record) => {
      records.push(record);
      if (record.type === "agent_settled") resolve();
    }),
  );

  const data = await child.send({ type: "prompt", message: "Task: test" });
  assert.deepEqual(data, { disposition: "started" });
  await settled;
  assert.equal(await child.close(), 0);

  const message = records.find((record) => record.type === "message_end");
  assert.deepEqual(message?.message, {
    role: "assistant",
    content: "line same line",
  });
  const answer = records.find((record) => record.type === "ui_answer");
  assert.deepEqual(answer?.response, {
    type: "extension_ui_response",
    id: "dialog-1",
    cancelled: true,
  });
});

test("a child that exits mid-command rejects it with its stderr", async () => {
  const child = startFake("crash");
  await assert.rejects(
    child.send({ type: "prompt", message: "Task: test" }),
    /Subagent process exited: boom/,
  );
  assert.equal(await child.exited, 3);
  await assert.rejects(
    child.send({ type: "get_state" }),
    /Subagent process has exited/,
  );
});

test("abort sends the abort command before closing stdin", async () => {
  const child = startFake("hang");
  await child.send({ type: "prompt", message: "Task: test" });
  assert.equal(await child.abort(), 0);
  assert.equal(child.stderr(), "commands: prompt,abort");
});

test("a dialog handler answers child dialogs; a failing one cancels", async () => {
  const answers = async (onDialog: DialogHandler) => {
    const child = new RpcChild(
      process.execPath,
      [FAKE_PI, "complete"],
      process.cwd(),
      onDialog,
    );
    const answer = new Promise<RpcRecord>((resolve) =>
      child.onRecord((record) => {
        if (record.type === "ui_answer") resolve(record);
      }),
    );
    await child.send({ type: "prompt", message: "Task: test" });
    const { response } = await answer;
    await child.close();
    return response;
  };

  const seen: RpcRecord[] = [];
  assert.deepEqual(
    await answers(async (request) => {
      seen.push(request);
      return { confirmed: true };
    }),
    { type: "extension_ui_response", id: "dialog-1", confirmed: true },
  );
  assert.equal(seen[0].title, "Allow?");
  assert.deepEqual(
    await answers(async () => {
      throw new Error("no UI");
    }),
    { type: "extension_ui_response", id: "dialog-1", cancelled: true },
  );
});

test("the exit signal aborts when the child exits", async () => {
  let exitSignal: AbortSignal | undefined;
  const child = new RpcChild(
    process.execPath,
    [FAKE_PI, "complete"],
    process.cwd(),
    (_request, childExited) => {
      exitSignal = childExited;
      return new Promise(() => {});
    },
  );
  await child.send({ type: "prompt", message: "Task: test" });
  while (!exitSignal) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exitSignal.aborted, false);
  await child.close();
  assert.equal(exitSignal.aborted, true);
});

test("close reports the signal it had to send", async () => {
  // Each child answers a command first, so it is running when close starts.
  const child = startFake("linger");
  await child.send({ type: "prompt", message: "Task: test" });
  assert.equal(await child.close(100), 1);
  assert.equal(child.forcedStop, "SIGTERM");

  const polite = startFake("complete");
  await polite.send({ type: "prompt", message: "Task: test" });
  assert.equal(await polite.close(5_000), 0);
  assert.equal(polite.forcedStop, undefined);
});

test("the fake child refuses an unknown mode instead of guessing", async () => {
  const child = startFake("compelte");
  assert.notEqual(await child.exited, 0);
  assert.match(child.stderr(), /fake-pi: unknown mode compelte/);
});
