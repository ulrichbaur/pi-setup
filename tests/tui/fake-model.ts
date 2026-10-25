import { createServer, type Server } from "node:http";

// An OpenAI-compatible chat completions endpoint with scripted answers, so
// real Pi can run in a test without cost or network.

type Message = {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
};

export type Reply =
  | { text: string }
  | { tool: string; args: Record<string, unknown> };

export type Script = (messages: Message[]) => Reply;

export function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("\n");
}

function chunk(delta: unknown, finish: string | null, usage?: unknown) {
  const body = {
    id: "fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

let calls = 0;

export async function startFakeModel(
  script: Script,
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (data) => {
      body += data;
    });
    request.on("end", () => {
      const { messages } = JSON.parse(body) as { messages: Message[] };
      const reply = script(messages);
      const usage = {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      if ("text" in reply) {
        response.write(chunk({ role: "assistant", content: reply.text }, null));
        response.write(chunk({}, "stop", usage));
      } else {
        calls += 1;
        const call = {
          index: 0,
          id: `call_${calls}`,
          type: "function",
          function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
        };
        response.write(chunk({ role: "assistant", tool_calls: [call] }, null));
        response.write(chunk({}, "tool_calls", usage));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, port: address.port };
}
