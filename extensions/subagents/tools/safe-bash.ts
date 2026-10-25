import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  analyzeBashCommand,
  headlessBlockReason,
} from "../../../lib/bash-policy.ts";

// Set by the parent when a user can answer confirmations.
export const ASK_FLAG = "safe-bash-ask";

export function dangerousCommandReason(command: string): string | null {
  const reason = headlessBlockReason(command);
  return reason ? `Command blocked by safe_bash: ${reason}` : null;
}

export async function commandBlockReason(
  command: string,
  confirm?: (title: string, message: string) => Promise<boolean>,
): Promise<string | null> {
  if (!confirm) return dangerousCommandReason(command);

  const headless = headlessBlockReason(command);
  const reasons = new Set(analyzeBashCommand(command)?.reasons);
  if (headless) reasons.add(headless);
  if (reasons.size === 0) return null;

  const list = [...reasons].map((reason) => `• ${reason}`).join("\n");
  const approved = await confirm(
    "Run this command?",
    `${list}\n\nCommand:\n${command}`,
  );
  return approved
    ? null
    : "Command blocked by the user through safe_bash. Propose a safer command or ask before trying a materially different operation.";
}

export default function safeBash(pi: ExtensionAPI): void {
  pi.registerFlag(ASK_FLAG, {
    description:
      "Ask the user about risky commands instead of applying the headless policy",
    type: "boolean",
    default: false,
  });
  const bashTool = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...bashTool,
    name: "safe_bash",
    label: "Safe Bash",
    description:
      "Execute a bash command. Risky commands need the user's approval when a user is available; otherwise catastrophic operations and parent-session Git actions are blocked.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const ask = pi.getFlag(ASK_FLAG) === true && ctx.hasUI;
      const reason = await commandBlockReason(
        params.command,
        ask
          ? (title, message) => ctx.ui.confirm(title, message, { signal })
          : undefined,
      );
      if (reason) throw new Error(reason);
      return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
