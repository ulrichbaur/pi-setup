import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const ASKED =
  "Your question goes to the agent that gave you this task. Your run ends here; its answer arrives as your next task.";

export default function askParent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_parent",
    label: "Ask Parent",
    description:
      "Ask the agent that gave you this task a question when you cannot continue without its answer. Make all the progress you can first. Your run ends, and the answer arrives as your next task.",
    promptSnippet: "Ask the agent that gave you this task a question",
    parameters: Type.Object({
      question: Type.String({
        description:
          "One clear question, with the context the parent needs to answer it",
      }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text" as const, text: ASKED }],
        details: { question: params.question },
        // The run stops after this tool, so the parent gets the question.
        terminate: true,
      };
    },
  });
}
