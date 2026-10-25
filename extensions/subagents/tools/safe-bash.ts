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

export type Approval = "run" | "allow" | "block";

/** Asks the user; `canAllow` offers to allow this kind for the rest of the run. */
export type AskApproval = (
  message: string,
  canAllow: boolean,
) => Promise<Approval>;

export const APPROVAL_OPTIONS = {
  run: "Run once",
  allow: "Allow this kind for this run",
  block: "Block",
} as const;

const BLOCKED_BY_USER =
  "Command blocked by the user through safe_bash. Propose a safer command or ask before trying a materially different operation.";

export async function commandBlockReason(
  command: string,
  ask?: AskApproval,
  allowed: Set<string> = new Set(),
): Promise<string | null> {
  if (!ask) return dangerousCommandReason(command);

  const headless = headlessBlockReason(command);
  const reasons = new Set(analyzeBashCommand(command)?.reasons);
  if (headless) reasons.add(headless);
  if (reasons.size === 0) return null;

  const kind = [...reasons].sort().join("\n");
  const canAllow = !headless;
  if (canAllow && allowed.has(kind)) return null;

  const list = [...reasons].map((reason) => `• ${reason}`).join("\n");
  const approval = await ask(`${list}\n\nCommand:\n${command}`, canAllow);
  if (approval === "block") return BLOCKED_BY_USER;
  if (approval === "allow" && canAllow) allowed.add(kind);
  return null;
}

export default function safeBash(pi: ExtensionAPI): void {
  pi.registerFlag(ASK_FLAG, {
    description:
      "Ask the user about risky commands instead of applying the headless policy",
    type: "boolean",
    default: false,
  });
  const bashTool = createBashToolDefinition(process.cwd());
  // A child process serves one run, so its allowances end with the run.
  const allowed = new Set<string>();

  pi.registerTool({
    ...bashTool,
    name: "safe_bash",
    label: "Safe Bash",
    description:
      "Execute a bash command. Risky commands need the user's approval when a user is available; otherwise catastrophic operations and parent-session Git actions are blocked.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const ask: AskApproval = async (message, canAllow) => {
        const title = "Run this command?";
        if (!canAllow) {
          return (await ctx.ui.confirm(title, message, { signal }))
            ? "run"
            : "block";
        }
        const choice = await ctx.ui.select(
          `${title}\n${message}`,
          [
            APPROVAL_OPTIONS.run,
            APPROVAL_OPTIONS.allow,
            APPROVAL_OPTIONS.block,
          ],
          { signal },
        );
        if (choice === APPROVAL_OPTIONS.run) return "run";
        if (choice === APPROVAL_OPTIONS.allow) return "allow";
        return "block";
      };
      const reason = await commandBlockReason(
        params.command,
        pi.getFlag(ASK_FLAG) === true && ctx.hasUI ? ask : undefined,
        allowed,
      );
      if (reason) throw new Error(reason);
      return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
