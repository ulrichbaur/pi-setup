// A stand-in for `pi --mode rpc`. The mode selects the behavior:
// "complete" finishes each prompt, "crash" exits during a prompt,
// "hang" waits until it receives an abort command, and "linger" keeps
// running after stdin closes.
import { createLineSplitter } from "../../../extensions/subagents/rpc.ts";

const MODES = ["complete", "crash", "hang", "linger"];

// Tests that start the fake pass the mode as the first argument. The
// extension starts it like Pi, with Pi's arguments; then FAKE_PI_MODE
// chooses the mode, and the arguments must ask for RPC mode.
function selectMode(args: string[]): string {
  if (args[0]?.startsWith("--")) {
    const rpc = args.findIndex(
      (arg, i) => arg === "--mode" && args[i + 1] === "rpc",
    );
    if (rpc === -1)
      throw new Error(`fake-pi: not started in RPC mode: ${args.join(" ")}`);
    return process.env.FAKE_PI_MODE ?? "complete";
  }
  return args[0] ?? "complete";
}

const mode = selectMode(process.argv.slice(2));
if (!MODES.includes(mode)) throw new Error(`fake-pi: unknown mode ${mode}`);
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
