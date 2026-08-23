import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { headlessBlockReason } from "../../bash-guard/policy.ts";

export function dangerousCommandReason(command: string): string | null {
  const reason = headlessBlockReason(command);
  return reason ? `Command blocked by safe_bash: ${reason}` : null;
}

export default function safeBash(pi: ExtensionAPI): void {
  const bashTool = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...bashTool,
    name: "safe_bash",
    label: "Safe Bash",
    description:
      "Execute a bash command after blocking catastrophic operations and parent-session Git actions.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const reason = dangerousCommandReason(params.command);
      if (reason) throw new Error(reason);
      return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
