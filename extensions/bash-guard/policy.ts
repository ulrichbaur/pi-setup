import { parse as parseShell } from "shell-quote";

export type BashRiskSeverity = "high" | "medium";

export type BashRisk = {
  severity: BashRiskSeverity;
  reasons: string[];
};

type OperatorToken = {
  op: string;
  pattern?: string;
};

type ShellToken = string | OperatorToken;

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "fish", "dash"]);
const CONTROL_OPERATORS = new Set(["&&", "||", ";", "&", "|"]);
const OUTPUT_OPERATORS = new Set([">", ">>"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FORK_BOMB_PATTERN = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;

function isOperator(token: ShellToken): token is OperatorToken {
  return typeof token === "object" && token !== null && "op" in token;
}

function tokenText(token: ShellToken): string | null {
  if (typeof token === "string") return token;
  return token.op === "glob" && token.pattern ? token.pattern : null;
}

function splitCommands(tokens: ShellToken[]): ShellToken[][] {
  const commands: ShellToken[][] = [];
  let current: ShellToken[] = [];
  for (const token of tokens) {
    if (isOperator(token) && CONTROL_OPERATORS.has(token.op)) {
      if (current.length > 0) commands.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

function commandWords(tokens: ShellToken[]): string[] {
  const words = tokens
    .map(tokenText)
    .filter((token): token is string => token !== null);
  while (words[0]?.match(ENV_ASSIGNMENT)) words.shift();

  if (words[0] === "command") words.shift();
  if (words[0] === "env") {
    words.shift();
    while (words[0]?.startsWith("-") || words[0]?.match(ENV_ASSIGNMENT)) {
      words.shift();
    }
  }
  return words;
}

function hasShortFlag(args: string[], flag: string): boolean {
  const letter = flag.replace(/^-/, "");
  return args.some(
    (argument) =>
      argument === flag ||
      (argument.startsWith("-") &&
        !argument.startsWith("--") &&
        argument.slice(1).includes(letter)),
  );
}

function addRisk(
  risks: BashRisk[],
  severity: BashRiskSeverity,
  reason: string,
): void {
  risks.push({ severity, reasons: [reason] });
}

function gitSubcommand(args: string[]): {
  subcommand: string | undefined;
  rest: string[];
} {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index];
    index += ["-C", "-c", "--git-dir", "--work-tree"].includes(option) ? 2 : 1;
  }
  return { subcommand: args[index], rest: args.slice(index + 1) };
}

function analyzeGit(args: string[], risks: BashRisk[]): void {
  const { subcommand, rest } = gitSubcommand(args);
  if (!subcommand) return;

  if (subcommand === "rm") {
    addRisk(risks, "high", "git rm deletes files and stages their removal");
    return;
  }
  if (subcommand === "reset" && rest.includes("--hard")) {
    addRisk(risks, "high", "git reset --hard discards working-tree changes");
    return;
  }
  if (
    subcommand === "clean" &&
    (hasShortFlag(rest, "-f") || rest.includes("--force"))
  ) {
    addRisk(risks, "high", "git clean can permanently delete untracked files");
    return;
  }
  if (
    subcommand === "push" &&
    (hasShortFlag(rest, "-f") ||
      rest.includes("--force") ||
      rest.includes("--force-with-lease"))
  ) {
    addRisk(risks, "high", "forced git push can rewrite remote history");
    return;
  }
  if (subcommand === "reflog" && rest[0] === "expire") {
    addRisk(risks, "high", "git reflog expire can remove recovery history");
    return;
  }
  if (
    subcommand === "gc" &&
    rest.some((argument) => argument.startsWith("--prune"))
  ) {
    addRisk(risks, "high", "git gc --prune can delete unreachable objects");
    return;
  }

  const mutating = new Set([
    "add",
    "am",
    "apply",
    "bisect",
    "cherry-pick",
    "checkout",
    "clone",
    "commit",
    "init",
    "merge",
    "mv",
    "notes",
    "pull",
    "push",
    "rebase",
    "reset",
    "restore",
    "revert",
    "stash",
    "switch",
  ]);
  if (mutating.has(subcommand)) {
    addRisk(risks, "medium", `git ${subcommand} changes repository state`);
    return;
  }

  if (subcommand === "branch") {
    const mutates = rest.some(
      (argument) =>
        !argument.startsWith("-") ||
        hasShortFlag([argument], "-d") ||
        hasShortFlag([argument], "-m") ||
        hasShortFlag([argument], "-c") ||
        ["--delete", "--move", "--copy"].includes(argument),
    );
    if (mutates) {
      addRisk(risks, "medium", "git branch changes branch references");
    }
    return;
  }

  if (subcommand === "tag") {
    const readOnly =
      rest.length === 0 ||
      rest.every(
        (argument) =>
          argument === "-l" ||
          argument === "--list" ||
          argument.startsWith("--format"),
      );
    if (!readOnly) addRisk(risks, "medium", "git tag changes tag references");
    return;
  }

  if (subcommand === "remote") {
    const action = rest.find((argument) => !argument.startsWith("-"));
    if (action && !["get-url", "show"].includes(action)) {
      addRisk(risks, "medium", `git remote ${action} changes remote settings`);
    }
    return;
  }

  if (subcommand === "config") {
    const readOnly = rest.some(
      (argument) =>
        argument === "--get" ||
        argument === "--get-all" ||
        argument === "--list" ||
        argument === "-l",
    );
    if (!readOnly) {
      addRisk(risks, "medium", "git config may change repository settings");
    }
    return;
  }

  if (subcommand === "worktree" && rest[0] !== "list") {
    addRisk(risks, "medium", "git worktree changes linked working trees");
  }
}

function analyzeCommand(
  tokens: ShellToken[],
  risks: BashRisk[],
  depth: number,
): void {
  const words = commandWords(tokens);
  if (words.length === 0) return;
  const command = words[0];
  const args = words.slice(1);

  if (command === "sudo") {
    addRisk(risks, "high", "sudo requests elevated privileges");
  }
  if (["rm", "rmdir", "unlink"].includes(command)) {
    addRisk(risks, "high", `${command} deletes files`);
  }
  if (command === "find" && args.includes("-delete")) {
    addRisk(risks, "high", "find -delete can remove many files");
  }
  if (command === "truncate") {
    addRisk(risks, "medium", "truncate changes a file in place");
  }
  if (
    command === "dd" &&
    (args.some((argument) => argument.startsWith("of=")) || args.includes("of"))
  ) {
    addRisk(risks, "high", "dd with an output target can overwrite data");
  }

  if (command.startsWith("mkfs") || command.startsWith("newfs_")) {
    addRisk(risks, "high", `${command} formats a filesystem`);
  }
  if (
    [
      "wipefs",
      "diskutil",
      "hdiutil",
      "gpt",
      "asr",
      "parted",
      "fdisk",
      "gdisk",
      "sgdisk",
      "cryptsetup",
      "pvcreate",
      "vgcreate",
      "lvcreate",
      "zpool",
    ].includes(command)
  ) {
    addRisk(risks, "high", `${command} manages disks or volumes`);
  }

  if (
    (command === "chmod" || command === "chown") &&
    (args.includes("-R") || args.includes("--recursive"))
  ) {
    addRisk(risks, "medium", `${command} recursively changes file metadata`);
  }
  if (
    (command === "mv" || command === "cp") &&
    (hasShortFlag(args, "-f") || args.includes("--force"))
  ) {
    addRisk(risks, "medium", `${command} --force can overwrite files`);
  }
  if (
    command === "sed" &&
    (hasShortFlag(args, "-i") || args.includes("--in-place"))
  ) {
    addRisk(risks, "medium", "sed -i modifies files in place");
  }
  if (
    command === "perl" &&
    (args.some((argument) => /^-[A-Za-z]*i[A-Za-z]*$/.test(argument)) ||
      args.includes("--in-place"))
  ) {
    addRisk(risks, "medium", "perl -i modifies files in place");
  }

  if (["kill", "pkill", "killall"].includes(command)) {
    addRisk(
      risks,
      args.includes("-9") ? "high" : "medium",
      `${command} terminates processes`,
    );
  }
  if (["shutdown", "reboot", "halt", "poweroff"].includes(command)) {
    addRisk(risks, "high", `${command} changes system power state`);
  }
  if (
    command === "systemctl" &&
    ["stop", "disable", "mask"].includes(args[0] ?? "")
  ) {
    addRisk(risks, "medium", `systemctl ${args[0]} disrupts a service`);
  }

  if (command === "kubectl" && args[0] === "delete") {
    addRisk(risks, "high", "kubectl delete removes cluster resources");
  }
  if (command === "terraform" && args[0] === "destroy") {
    addRisk(risks, "high", "terraform destroy removes infrastructure");
  }
  if (
    command === "aws" &&
    args[0] === "s3" &&
    args[1] === "rm" &&
    args.includes("--recursive")
  ) {
    addRisk(risks, "high", "aws s3 rm --recursive deletes many objects");
  }
  if (command === "gcloud" && args.includes("delete")) {
    addRisk(risks, "high", "gcloud delete removes cloud resources");
  }

  if (command === "git") analyzeGit(args, risks);

  if (depth < 2 && SHELL_COMMANDS.has(command)) {
    const commandIndex = args.indexOf("-c");
    const nested = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
    if (nested) {
      const nestedRisk = analyzeBashCommand(nested, depth + 1);
      if (nestedRisk) risks.push(nestedRisk);
    }
  }
}

function downloadsArePipedToShell(tokens: ShellToken[]): boolean {
  let current: ShellToken[] = [];
  let downloaderInPipeline = false;

  const finishCommand = (continuesPipeline: boolean): boolean => {
    const command = commandWords(current)[0];
    current = [];
    if (downloaderInPipeline && command && SHELL_COMMANDS.has(command)) {
      return true;
    }
    if (command === "curl" || command === "wget") downloaderInPipeline = true;
    if (!continuesPipeline) downloaderInPipeline = false;
    return false;
  };

  for (const token of tokens) {
    if (isOperator(token) && CONTROL_OPERATORS.has(token.op)) {
      if (finishCommand(token.op === "|")) return true;
    } else {
      current.push(token);
    }
  }
  return finishCommand(false);
}

function deduplicateRisk(risks: BashRisk[]): BashRisk | null {
  const reasons = [...new Set(risks.flatMap((risk) => risk.reasons))];
  if (reasons.length === 0) return null;
  return {
    severity: risks.some((risk) => risk.severity === "high")
      ? "high"
      : "medium",
    reasons,
  };
}

function parseCommand(
  command: string,
): ShellToken[] | "fork bomb" | "parse error" {
  const normalized = command.replace(/\\\n/g, " ");
  if (FORK_BOMB_PATTERN.test(normalized)) return "fork bomb";
  try {
    return parseShell(normalized) as ShellToken[];
  } catch {
    return "parse error";
  }
}

/** Analyze an agent-issued bash command using the balanced interactive policy. */
export function analyzeBashCommand(
  command: string,
  depth = 0,
): BashRisk | null {
  const parsed = parseCommand(command);
  if (typeof parsed === "string") {
    return parsed === "fork bomb"
      ? { severity: "high", reasons: ["the command contains a fork bomb"] }
      : {
          severity: "medium",
          reasons: ["the shell command could not be parsed safely"],
        };
  }

  const risks: BashRisk[] = [];
  if (
    parsed.some((token) => isOperator(token) && OUTPUT_OPERATORS.has(token.op))
  ) {
    addRisk(risks, "medium", "shell output redirection can overwrite files");
  }

  if (downloadsArePipedToShell(parsed)) {
    addRisk(risks, "high", "downloaded content is piped to a shell");
  }

  for (const segment of splitCommands(parsed)) {
    analyzeCommand(segment, risks, depth);
  }
  return deduplicateRisk(risks);
}

function headlessCommandReason(
  tokens: ShellToken[],
  depth: number,
): string | null {
  const words = commandWords(tokens);
  if (words.length === 0) return null;
  const command = words[0];
  const args = words.slice(1);

  if (command === "sudo") return "elevated privileges";
  if (
    command === "chmod" &&
    (hasShortFlag(args, "-R") || args.includes("--recursive")) &&
    args.includes("777") &&
    args.includes("/")
  ) {
    return "world-writable permissions on the filesystem root";
  }
  if (
    command === "chown" &&
    (hasShortFlag(args, "-R") || args.includes("--recursive")) &&
    args.includes("/")
  ) {
    return "recursive ownership change on the filesystem root";
  }
  if (command === "kill" && args.includes("-9") && args.includes("1")) {
    return "terminating the init process";
  }
  if (
    command === "rm" &&
    (hasShortFlag(args, "-r") || args.includes("--recursive"))
  ) {
    return "recursive file deletion";
  }
  if (command.startsWith("mkfs") || command.startsWith("newfs_")) {
    return "filesystem formatting";
  }
  if (command === "wipefs") return "disk signature removal";
  if (
    command === "diskutil" &&
    args.some((argument) =>
      ["erase", "zerodisk", "secureerase", "reformat"].some((action) =>
        argument.toLowerCase().startsWith(action),
      ),
    )
  ) {
    return "destructive disk operation";
  }
  if (
    command === "dd" &&
    args.some((argument) => argument.startsWith("of=/dev/"))
  ) {
    return "raw disk write";
  }
  if (["parted", "fdisk", "gdisk", "sgdisk"].includes(command)) {
    return "partition table management";
  }
  if (command === "cryptsetup") return "disk encryption management";
  if (command === "zpool") return "ZFS pool management";
  if (["shutdown", "reboot", "halt", "poweroff"].includes(command)) {
    return "system power operation";
  }
  if (command === "terraform" && args[0] === "destroy") {
    return "infrastructure teardown";
  }
  if (command === "kubectl" && args.includes("delete")) {
    return "Kubernetes resource deletion";
  }
  if (
    command === "aws" &&
    args[0] === "s3" &&
    args[1] === "rm" &&
    args.includes("--recursive")
  ) {
    return "bulk S3 deletion";
  }

  if (command === "git") {
    const { subcommand, rest } = gitSubcommand(args);
    if (["commit", "pull", "push"].includes(subcommand ?? "")) {
      return `git ${subcommand} is a parent-session operation`;
    }
    if (subcommand === "reset" && rest.includes("--hard")) {
      return "discarding uncommitted changes";
    }
    if (
      subcommand === "clean" &&
      (hasShortFlag(rest, "-f") || rest.includes("--force"))
    ) {
      return "deleting untracked files";
    }
    if (subcommand === "reflog" && rest[0] === "expire") {
      return "removing recovery history";
    }
    if (
      subcommand === "gc" &&
      rest.some((argument) => argument.startsWith("--prune"))
    ) {
      return "pruning unreachable Git objects";
    }
  }

  if (depth < 2 && SHELL_COMMANDS.has(command)) {
    const commandIndex = args.indexOf("-c");
    const nested = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
    if (nested) return headlessBlockReason(nested, depth + 1);
  }
  return null;
}

/** Return why a command is forbidden in a non-interactive worker. */
export function headlessBlockReason(command: string, depth = 0): string | null {
  const parsed = parseCommand(command);
  if (typeof parsed === "string") {
    return parsed === "fork bomb"
      ? "fork bomb"
      : "the shell command could not be parsed safely";
  }
  if (downloadsArePipedToShell(parsed)) {
    return "downloaded content piped to a shell";
  }
  for (const segment of splitCommands(parsed)) {
    const reason = headlessCommandReason(segment, depth);
    if (reason) return reason;
  }
  return null;
}
