import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)?(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\/|~\/?\s|~\/?\b)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\//,
  /\bchown\s+(-[a-zA-Z]+\s+)?root/,
  /\bcurl\s.*\|\s*(ba)?sh/,
  /\bwget\s.*\|\s*(ba)?sh/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  /\bkill\s+-9\s+1\b/,
  /\bkillall\b/,
];

export function dangerousCommandReason(command: string): string | null {
  const normalized = command.replace(/\\\n/g, " ");
  const pattern = DANGEROUS_PATTERNS.find((candidate) =>
    candidate.test(normalized),
  );
  return pattern
    ? `Command blocked by safe_bash because it matches ${pattern}`
    : null;
}

export default function safeBash(pi: ExtensionAPI): void {
  const bashTool = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...bashTool,
    name: "safe_bash",
    label: "Safe Bash",
    description:
      "Execute a bash command after blocking common destructive system commands.",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const reason = dangerousCommandReason(params.command);
      if (reason) throw new Error(reason);
      return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
