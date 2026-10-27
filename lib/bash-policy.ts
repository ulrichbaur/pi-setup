import { posix } from "node:path";
import { parse as parseShell } from "shell-quote";

export type BashRiskSeverity = "high" | "medium";

export type BashFinding = {
  /** The risky step, as the policy read it. */
  command: string;
  reason: string;
};

export type BashRisk = {
  severity: BashRiskSeverity;
  findings: BashFinding[];
  /**
   * True for several lines, command substitution, or shell control flow,
   * which a person cannot review reliably as a whole.
   */
  complex: boolean;
};

/**
 * One row of the shared policy table. The interactive guard asks the user
 * about every row with a severity; the subagent `safe_bash` tool blocks
 * every row.
 */
export type PolicyRule = {
  /** Returns the reason when the rule applies to this command, otherwise null. */
  match(command: string, args: string[]): string | null;
  /** Interactive rating. null means only subagents are stopped. */
  severity: BashRiskSeverity | null;
};

type OperatorToken = {
  op: string;
  pattern?: string;
};

type ShellToken = string | OperatorToken;

type Match = {
  rule: PolicyRule;
  finding: BashFinding;
};

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "fish", "dash"]);
// Parentheses also end a step, so subshells and `$(…)` are read on their own.
const CONTROL_OPERATORS = new Set(["&&", "||", ";", "&", "|", "(", ")"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FORK_BOMB_PATTERN = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/;
const MAX_SHELL_DEPTH = 2;
// A heredoc: its operator line, its body, and the closing delimiter.
const HEREDOC =
  /(<<-?[ \t]*)(['"]?)(\w+)\2([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\3[ \t]*(?=\n|$)/g;
const COMPLEX_SHAPE =
  /\n|`|[$<>]\(|(^|[;&|({]\s*)(if|then|elif|else|for|while|until|do|case)\b/;
const MAX_STEP_LENGTH = 80;

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

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

// Programs that run the rest of their arguments as a command.
const SIMPLE_WRAPPERS = new Set(["command", "nohup", "time", "busybox"]);
// Shell words that may come before a command; `exec` runs it in place.
const LEADING_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "{",
  "exec",
]);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set([
  "-s",
  "-k",
  "--signal",
  "--kill-after",
]);

/** Skips leading option words, consuming a value for the listed options. */
function skipOptions(
  words: string[],
  start: number,
  withValue: ReadonlySet<string>,
): number {
  let index = start;
  while (words[index]?.startsWith("-")) {
    index += withValue.has(words[index]) ? 2 : 1;
  }
  return index;
}

/**
 * Strips variable assignments, shell keywords, and wrappers such as `env`,
 * `nice`, `nohup`, `time`, `timeout`, and `busybox`, and reduces a command
 * path to its name, so the words start at the real command.
 */
function normalizeWords(input: string[]): string[] {
  let words = input;
  for (;;) {
    while (words[0]?.match(ENV_ASSIGNMENT)) words = words.slice(1);
    if (words[0]?.includes("/")) {
      words = [posix.basename(words[0]), ...words.slice(1)];
    }
    const head = words[0];
    if (head === undefined) return words;
    if (SIMPLE_WRAPPERS.has(head) || LEADING_KEYWORDS.has(head)) {
      words = words.slice(1);
    } else if (head === "env") {
      words = words.slice(skipOptions(words, 1, new Set()));
    } else if (head === "nice") {
      words = words.slice(skipOptions(words, 1, new Set(["-n"])));
    } else if (head === "timeout") {
      // The word after the options is the duration, not the command.
      words = words.slice(
        skipOptions(words, 1, TIMEOUT_OPTIONS_WITH_VALUE) + 1,
      );
    } else {
      return words;
    }
  }
}

function commandWords(tokens: ShellToken[]): string[] {
  return normalizeWords(
    tokens.map(tokenText).filter((token): token is string => token !== null),
  );
}

// Options of xargs whose value is a separate word.
const XARGS_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "-d",
  "-E",
  "-e",
  "-I",
  "-i",
  "-L",
  "-l",
  "-n",
  "-P",
  "-s",
  "--arg-file",
  "--delimiter",
  "--eof",
  "--replace",
  "--max-lines",
  "--max-args",
  "--max-procs",
  "--max-chars",
]);
const FIND_EXEC_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const MAX_DELEGATIONS = 8;

/** The command words that `find -exec` and friends run per match. */
function findExecCommands(args: string[]): string[][] {
  const commands: string[][] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (!FIND_EXEC_ACTIONS.has(args[index])) continue;
    const words: string[] = [];
    for (
      index += 1;
      index < args.length && args[index] !== ";" && args[index] !== "+";
      index += 1
    ) {
      words.push(args[index]);
    }
    if (words.length > 0) commands.push(words);
  }
  return commands;
}

/**
 * Returns the segment's own command followed by every command it delegates
 * to through `xargs` or `find -exec`, each normalized like a top-level one.
 */
function delegatedCommands(words: string[]): string[][] {
  const commands: string[][] = [];
  const queue = [words];
  while (queue.length > 0 && commands.length < MAX_DELEGATIONS) {
    const current = normalizeWords(queue.shift() as string[]);
    if (current.length === 0) continue;
    commands.push(current);
    const [name, ...args] = current;
    if (name === "xargs") {
      const delegated = args.slice(
        skipOptions(args, 0, XARGS_OPTIONS_WITH_VALUE),
      );
      if (delegated.length > 0) queue.push(delegated);
    }
    if (name === "find") queue.push(...findExecCommands(args));
  }
  return commands;
}

/** Command strings that a shell, `su -c`, or `eval` would run. */
function nestedShellCommands(name: string, args: string[]): string[] {
  if (name === "eval") return args.length > 0 ? [args.join(" ")] : [];
  if (SHELL_COMMANDS.has(name) || name === "su") {
    // `-c` may share a word with other short options, as in `-lc`.
    const commandIndex = args.findIndex((argument) =>
      /^-[A-Za-z]*c[A-Za-z]*$/.test(argument),
    );
    const nested = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
    return nested ? [nested] : [];
  }
  return [];
}

/** True when the last command on this line is a shell, which runs its input. */
function feedsShell(line: string): boolean {
  const segment = line.split(/[;&|]/).at(-1) ?? "";
  const [name = ""] = normalizeWords(segment.trim().split(/\s+/));
  return SHELL_COMMANDS.has(name);
}

/**
 * Joins continued lines and drops heredoc bodies, which are data,
 * unless a shell reads the body as a script.
 */
function readableText(command: string): string {
  return command
    .replace(/\\\n/g, " ")
    .replace(
      HEREDOC,
      (
        heredoc: string,
        operator: string,
        _quote: string,
        delimiter: string,
        rest: string,
        offset: number,
        text: string,
      ) => {
        const line = text.slice(text.lastIndexOf("\n", offset) + 1, offset);
        return feedsShell(line) ? heredoc : `${operator}${delimiter}${rest}`;
      },
    );
}

function parseCommand(
  command: string,
): ShellToken[] | "fork bomb" | "parse error" {
  const text = readableText(command);
  if (FORK_BOMB_PATTERN.test(text)) return "fork bomb";
  try {
    // A newline or a backtick ends a step like `;` does. Variables keep
    // their names, so a finding shows `$file` rather than an empty word.
    return parseShell(
      text.replace(/[\n`]/g, ";"),
      (name) => `$${name}`,
    ) as ShellToken[];
  } catch {
    return "parse error";
  }
}

/** Long steps are cut, so a finding stays one readable line. */
function shorten(text: string): string {
  return text.length > MAX_STEP_LENGTH
    ? `${text.slice(0, MAX_STEP_LENGTH - 1)}…`
    : text;
}

/** The step as the user would type it. */
function stepText(words: string[]): string {
  return shorten(
    words
      .map((word) => (/\s/.test(word) ? JSON.stringify(word) : word))
      .join(" "),
  );
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

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

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

function isRecursive(args: string[]): boolean {
  return (
    hasShortFlag(args, "-r") ||
    hasShortFlag(args, "-R") ||
    args.includes("--recursive")
  );
}

function isForced(args: string[]): boolean {
  return hasShortFlag(args, "-f") || args.includes("--force");
}

/** `git restore --staged` without `--worktree` only unstages, which is recoverable. */
function restoresIndexOnly(rest: string[]): boolean {
  const staged = rest.includes("--staged") || hasShortFlag(rest, "-S");
  const worktree = rest.includes("--worktree") || hasShortFlag(rest, "-W");
  return staged && !worktree;
}

function diskutilErases(args: string[]): boolean {
  return args.some((argument) =>
    ["erase", "zerodisk", "secureerase", "reformat"].some((action) =>
      argument.toLowerCase().startsWith(action),
    ),
  );
}

/** True for the metadata changes that can make a machine unusable. */
function changesFilesystemRoot(command: string, args: string[]): boolean {
  if (!args.includes("/")) return false;
  return command === "chown" || args.includes("777");
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

// ---------------------------------------------------------------------------
// Rule constructors
// ---------------------------------------------------------------------------

type CommandSelector =
  | string
  | readonly string[]
  | ((command: string) => boolean);
type Matcher = PolicyRule["match"];

function selects(selector: CommandSelector, command: string): boolean {
  if (typeof selector === "string") return selector === command;
  if (typeof selector === "function") return selector(command);
  return selector.includes(command);
}

/** Matches a command by name and derives the reason from its arguments. */
function is(
  selector: CommandSelector,
  reason: (args: string[], command: string) => string | null,
): Matcher {
  return (command, args) =>
    selects(selector, command) ? reason(args, command) : null;
}

/** Matches a Git subcommand and derives the reason from its remaining arguments. */
function git(
  selector: CommandSelector,
  reason: (rest: string[], subcommand: string) => string | null,
): Matcher {
  return (command, args) => {
    if (command !== "git") return null;
    const { subcommand, rest } = gitSubcommand(args);
    if (!subcommand || !selects(selector, subcommand)) return null;
    return reason(rest, subcommand);
  };
}

const always = (reason: string) => () => reason;
const named =
  (template: (command: string) => string) => (_: string[], command: string) =>
    template(command);

// ---------------------------------------------------------------------------
// Whole-command rules
// ---------------------------------------------------------------------------

// These rules judge the command text or pipeline shape rather than one segment.
const FORK_BOMB: PolicyRule = {
  match: () => "the command contains a fork bomb",
  severity: "high",
};
const UNPARSEABLE: PolicyRule = {
  match: () => "the shell command could not be parsed safely",
  severity: "medium",
};
const DOWNLOAD_TO_SHELL: PolicyRule = {
  match: () => "downloaded content is piped to a shell",
  severity: "high",
};

// ---------------------------------------------------------------------------
// Per-command rules
// ---------------------------------------------------------------------------

/**
 * Every row applies to one command segment after env prefixes are stripped.
 * A row with `severity: null` is invisible to the interactive guard.
 * Rows are ordered so that the more specific reason comes first.
 */
export const POLICY_RULES: readonly PolicyRule[] = [
  // Privileges
  {
    match: is(
      ["sudo", "doas", "pkexec", "su"],
      named((command) => `${command} requests elevated privileges`),
    ),
    severity: "high",
  },

  // File deletion
  {
    match: is(["rm", "rmdir", "unlink"], (args, command) =>
      command === "rm" && isRecursive(args)
        ? "rm -r performs recursive file deletion"
        : `${command} deletes files`,
    ),
    severity: "high",
  },
  {
    match: is("find", (args) =>
      args.includes("-delete") ? "find -delete can remove many files" : null,
    ),
    severity: "high",
  },
  {
    match: is("shred", always("shred destroys file contents beyond recovery")),
    severity: "high",
  },

  // Disks and volumes
  {
    match: is("dd", (args) => {
      const target = args.find((argument) => argument.startsWith("of="));
      if (!target) return null;
      return target.startsWith("of=/dev/")
        ? "dd writes to a raw disk"
        : "dd with an output target can overwrite data";
    }),
    severity: "high",
  },
  {
    match: is(
      (command) => command.startsWith("mkfs") || command.startsWith("newfs_"),
      named((command) => `${command} formats a filesystem`),
    ),
    severity: "high",
  },
  {
    match: is("wipefs", always("wipefs removes disk signatures")),
    severity: "high",
  },
  {
    match: is(
      ["diskutil", "hdiutil", "gpt", "asr", "pvcreate", "vgcreate", "lvcreate"],
      (args, command) =>
        command === "diskutil" && diskutilErases(args)
          ? "diskutil erases a disk"
          : `${command} manages disks or volumes`,
    ),
    severity: "high",
  },
  {
    match: is(
      ["parted", "fdisk", "gdisk", "sgdisk"],
      named((command) => `${command} manages partition tables`),
    ),
    severity: "high",
  },
  {
    match: is("cryptsetup", always("cryptsetup manages disk encryption")),
    severity: "high",
  },
  {
    match: is("zpool", always("zpool manages ZFS pools")),
    severity: "high",
  },

  // File metadata
  {
    match: is("chmod", (args) =>
      isRecursive(args) && changesFilesystemRoot("chmod", args)
        ? "chmod sets world-writable permissions on the filesystem root"
        : null,
    ),
    severity: "high",
  },
  {
    match: is("chown", (args) =>
      isRecursive(args) && changesFilesystemRoot("chown", args)
        ? "chown recursively changes ownership of the filesystem root"
        : null,
    ),
    severity: "high",
  },
  {
    match: is(["chmod", "chown"], (args, command) =>
      isRecursive(args) && !changesFilesystemRoot(command, args)
        ? `${command} recursively changes file metadata`
        : null,
    ),
    severity: "medium",
  },

  // Processes and power
  {
    match: is(["kill", "pkill", "killall"], (args, command) => {
      if (!args.includes("-9")) return null;
      return command === "kill" && args.includes("1")
        ? "kill -9 1 terminates the init process"
        : `${command} -9 terminates processes`;
    }),
    severity: "high",
  },
  {
    match: is(["kill", "pkill", "killall"], (args, command) =>
      args.includes("-9") ? null : `${command} terminates processes`,
    ),
    severity: "medium",
  },
  {
    match: is(
      ["shutdown", "reboot", "halt", "poweroff"],
      named((command) => `${command} changes system power state`),
    ),
    severity: "high",
  },
  {
    match: is("systemctl", (args) =>
      ["stop", "disable", "mask"].includes(args[0] ?? "")
        ? `systemctl ${args[0]} disrupts a service`
        : null,
    ),
    severity: "medium",
  },

  // Infrastructure
  {
    match: is("kubectl", (args) =>
      args.includes("delete")
        ? "kubectl delete removes cluster resources"
        : null,
    ),
    severity: "high",
  },
  {
    match: is("terraform", (args) =>
      args[0] === "destroy" ? "terraform destroy removes infrastructure" : null,
    ),
    severity: "high",
  },
  {
    match: is("aws", (args) =>
      args[0] === "s3" && args[1] === "rm" && args.includes("--recursive")
        ? "aws s3 rm --recursive deletes many objects"
        : null,
    ),
    severity: "high",
  },
  {
    match: is("gcloud", (args) =>
      args.includes("delete") ? "gcloud delete removes cloud resources" : null,
    ),
    severity: "high",
  },

  // Git: hard to recover
  {
    match: git("rm", always("git rm deletes files and stages their removal")),
    severity: "high",
  },
  {
    match: git("reset", (rest) =>
      rest.includes("--hard")
        ? "git reset --hard discards working-tree changes"
        : null,
    ),
    severity: "high",
  },
  {
    match: git("clean", (rest) =>
      isForced(rest)
        ? "git clean can permanently delete untracked files"
        : null,
    ),
    severity: "high",
  },
  {
    match: git("checkout", (rest) =>
      rest.includes("--") || rest.includes(".") || isForced(rest)
        ? "git checkout with a pathspec overwrites working-tree changes"
        : null,
    ),
    severity: "high",
  },
  {
    match: git("switch", (rest) =>
      rest.includes("--discard-changes") || isForced(rest)
        ? "git switch --discard-changes overwrites working-tree changes"
        : null,
    ),
    severity: "high",
  },
  {
    match: git("restore", (rest) =>
      restoresIndexOnly(rest)
        ? null
        : "git restore overwrites working-tree changes",
    ),
    severity: "high",
  },
  {
    match: git("stash", (rest) =>
      ["drop", "clear"].includes(rest[0] ?? "")
        ? `git stash ${rest[0]} discards stashed changes`
        : null,
    ),
    severity: "high",
  },
  {
    match: git("push", (rest) =>
      isForced(rest) || rest.includes("--force-with-lease")
        ? "forced git push can rewrite remote history"
        : null,
    ),
    severity: "high",
  },
  {
    match: git("reflog", (rest) =>
      rest[0] === "expire"
        ? "git reflog expire can remove recovery history"
        : null,
    ),
    severity: "high",
  },
  {
    match: git("gc", (rest) =>
      rest.some((argument) => argument.startsWith("--prune"))
        ? "git gc --prune can delete unreachable objects"
        : null,
    ),
    severity: "high",
  },

  // Git: parent-session operations
  {
    match: git("push", (rest) =>
      isForced(rest) || rest.includes("--force-with-lease")
        ? null
        : "git push publishes to a remote (a parent-session operation)",
    ),
    severity: "medium",
  },
  {
    match: git(
      ["commit", "pull"],
      (_, subcommand) => `git ${subcommand} is a parent-session operation`,
    ),
    severity: null,
  },
  {
    match: git("stash", (rest) =>
      ["drop", "clear"].includes(rest[0] ?? "")
        ? null
        : "git stash moves the parent session's working-tree changes",
    ),
    severity: null,
  },

  // Git: recoverable through the index or reflog, but still worth a look
  {
    match: git(
      [
        "am",
        "apply",
        "bisect",
        "cherry-pick",
        "notes",
        "rebase",
        "reset",
        "restore",
        "revert",
      ],
      (rest, subcommand) => {
        if (subcommand === "reset" && rest.includes("--hard")) return null;
        if (subcommand === "restore" && !restoresIndexOnly(rest)) return null;
        return `git ${subcommand} changes repository state`;
      },
    ),
    severity: "medium",
  },
  {
    match: git("branch", (rest) =>
      rest.some(
        (argument) =>
          !argument.startsWith("-") ||
          hasShortFlag([argument], "-d") ||
          hasShortFlag([argument], "-m") ||
          hasShortFlag([argument], "-c") ||
          ["--delete", "--move", "--copy"].includes(argument),
      )
        ? "git branch changes branch references"
        : null,
    ),
    severity: "medium",
  },
  {
    match: git("tag", (rest) =>
      rest.length === 0 ||
      rest.every(
        (argument) =>
          argument === "-l" ||
          argument === "--list" ||
          argument.startsWith("--format"),
      )
        ? null
        : "git tag changes tag references",
    ),
    severity: "medium",
  },
  {
    match: git("remote", (rest) => {
      const action = rest.find((argument) => !argument.startsWith("-"));
      return action && !["get-url", "show"].includes(action)
        ? `git remote ${action} changes remote settings`
        : null;
    }),
    severity: "medium",
  },
  {
    match: git("config", (rest) =>
      rest.some((argument) =>
        ["--get", "--get-all", "--list", "-l"].includes(argument),
      )
        ? null
        : "git config may change repository settings",
    ),
    severity: "medium",
  },
  {
    match: git("worktree", (rest) =>
      rest[0] === "list" ? null : "git worktree changes linked working trees",
    ),
    severity: "medium",
  },
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Parses the command and returns every matching rule the caller cares about.
 * Both policies share this walk; they differ only in the `applies` filter.
 */
function evaluate(
  command: string,
  depth: number,
  applies: (rule: PolicyRule) => boolean,
): Match[] {
  const whole = shorten(command.replace(/\s+/g, " ").trim());
  const structural = (rule: PolicyRule): Match[] =>
    applies(rule)
      ? [
          {
            rule,
            finding: { command: whole, reason: rule.match("", []) ?? "" },
          },
        ]
      : [];

  const parsed = parseCommand(command);
  if (parsed === "fork bomb") return structural(FORK_BOMB);
  if (parsed === "parse error") return structural(UNPARSEABLE);

  const matches: Match[] = [];
  if (downloadsArePipedToShell(parsed)) {
    matches.push(...structural(DOWNLOAD_TO_SHELL));
  }

  for (const segment of splitCommands(parsed)) {
    for (const [name, ...args] of delegatedCommands(commandWords(segment))) {
      for (const rule of POLICY_RULES) {
        if (!applies(rule)) continue;
        const reason = rule.match(name, args);
        if (reason) {
          const step = stepText([name, ...args]);
          matches.push({ rule, finding: { command: step, reason } });
        }
      }

      if (depth < MAX_SHELL_DEPTH) {
        for (const nested of nestedShellCommands(name, args)) {
          matches.push(...evaluate(nested, depth + 1, applies));
        }
      }
    }
  }
  return matches;
}

function assess(
  command: string,
  applies: (rule: PolicyRule) => boolean,
): BashRisk | null {
  const matches = evaluate(command, 0, applies);
  if (matches.length === 0) return null;
  const findings = new Map<string, BashFinding>();
  for (const { finding } of matches) {
    findings.set(`${finding.command}\n${finding.reason}`, finding);
  }
  return {
    severity: matches.some((match) => match.rule.severity === "high")
      ? "high"
      : "medium",
    findings: [...findings.values()],
    complex: COMPLEX_SHAPE.test(readableText(command).trim()),
  };
}

/** The rows the interactive guard asks the user about. */
export function analyzeBashCommand(command: string): BashRisk | null {
  return assess(command, (rule) => rule.severity !== null);
}

/** Every row, for subagents, which have no user to ask. */
export function subagentRisk(command: string): BashRisk | null {
  return assess(command, () => true);
}

/** One entry per finding: the step, then why it is risky. */
export function formatFindings(findings: BashFinding[]): string {
  return findings
    .map(({ command, reason }) => `• ${command}\n  ${reason}`)
    .join("\n");
}
