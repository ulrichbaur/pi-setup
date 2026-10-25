import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const NO_ANSWER =
  "No answer: the user is not available or dismissed the question. Continue with your best judgment and state the assumption you made.";

export async function askQuestion(
  ui: Pick<ExtensionUIContext, "select" | "input"> | undefined,
  question: string,
  options: string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (!ui) return undefined;
  const answer = options?.length
    ? await ui.select(question, options, { signal })
    : await ui.input(question, undefined, { signal });
  return answer?.trim() || undefined;
}

export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a clarifying question and wait for the answer. Use it only when the answer changes the result and you cannot find it yourself.",
    promptSnippet: "Ask the user a clarifying question",
    parameters: Type.Object({
      question: Type.String({ description: "One clear question" }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description: "Answers to choose from; omit for a free-text answer",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const answer = await askQuestion(
        ctx.hasUI ? ctx.ui : undefined,
        params.question,
        params.options,
        signal,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: answer ? `The user answered: ${answer}` : NO_ANSWER,
          },
        ],
        details: { answered: answer !== undefined },
      };
    },
  });
}
