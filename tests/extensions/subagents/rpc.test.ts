import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  createLineSplitter,
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
