import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { subagentRisk } from "../../../lib/bash-policy.ts";

/** A subagent has no user to ask, so every risky command is blocked. */
export function commandBlockReason(command: string): string | null {
  const risk = subagentRisk(command);
  if (!risk) return null;
  return `Command blocked by safe_bash: ${risk.reasons.join("; ")}. Use a safer command, or ask the agent that gave you this task to run it.`;
}

export default function safeBash(pi: ExtensionAPI): void {
  const bashTool = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...bashTool,
    name: "safe_bash",
    label: "Safe Bash",
    description:
      "Execute a bash command. Risky commands, such as deletions, Git actions on the parent session, and catastrophic operations, are blocked.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const reason = commandBlockReason(params.command);
      if (reason) throw new Error(reason);
      return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
