// A stand-in for `pi --mode rpc`. The first argument selects the behavior:
// "complete" finishes each prompt, "crash" exits during a prompt,
// "hang" waits until it receives an abort command, and "linger" keeps
// running after stdin closes. Any other value behaves like "complete".
import { createLineSplitter } from "../../../extensions/subagents/rpc.ts";

const mode = process.argv[2] ?? "complete";
const seen: string[] = [];
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);

const splitter = createLineSplitter((line) => {
  const record = JSON.parse(line);
  seen.push(record.type);
  if (record.type === "extension_ui_response") {
    send({ type: "ui_answer", response: record });
    send({ type: "agent_settled" });
    return;
  }
  if (record.type === "abort") {
    send({ id: record.id, type: "response", command: "abort", success: true });
    send({ type: "agent_settled" });
    return;
  }
  if (record.type !== "prompt") return;
  if (mode === "crash") {
    process.stderr.write("boom\n");
    process.exit(3);
  }
  send({
    id: record.id,
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });
  if (mode === "hang") return;
  send({
    type: "message_end",
    message: { role: "assistant", content: "line same line" },
  });
  send({
    type: "extension_ui_request",
    id: "dialog-1",
    method: "confirm",
    title: "Allow?",
  });
});

process.stdin.on("data", (chunk: Buffer) => splitter.write(chunk));
process.stdin.on("end", () => {
  if (mode === "linger") {
    setInterval(() => {}, 1_000);
    return;
  }
  splitter.end();
  process.stderr.write(`commands: ${seen.join(",")}\n`);
  process.exit(0);
});
