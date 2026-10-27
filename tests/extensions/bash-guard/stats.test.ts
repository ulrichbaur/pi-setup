import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatReport,
  inferDecisions,
  registerBashGuardCommand,
} from "../../../extensions/bash-guard/stats.ts";

const call = (id: string, command: string) => ({
  type: "message",
  timestamp: "2026-10-01T10:00:00.000Z",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
  },
});
const result = (id: string, text: string) => ({
  type: "message",
  timestamp: "2026-10-02T10:00:00.000Z",
  message: {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
  },
});

test("each bash call is paired with what its result shows", () => {
  const decisions = inferDecisions([
    call("a", "rm notes.txt"),
    result("a", ""),
    call("b", "git rebase main"),
    result(
      "b",
      "Blocked by the user through bash-guard. The user's rejection reason was: not now. Propose a safer command",
    ),
    call("c", "git rebase main"),
    result(
      "c",
      "Blocked by bash-guard because the same command was aborted recently.",
    ),
    call("d", "ls\nrm -rf build"),
    result("d", "Blocked by bash-guard: this command is too complex to review"),
  ]);
  assert.deepEqual(
    decisions.map(({ callId, outcome, rejectReason }) => [
      callId,
      outcome,
      rejectReason,
    ]),
    [
      ["a", "ran", undefined],
      ["b", "rejected", "not now"],
      ["c", "repeat", undefined],
      ["d", "blocked", undefined],
    ],
  );
});

test("the report counts a forked call once and groups by reason", () => {
  const session = [
    call("a", "rm notes.txt"),
    result("a", ""),
    call("b", "git rebase main"),
    result(
      "b",
      "Blocked by the user through bash-guard. The user's rejection reason was: not now. Propose",
    ),
    call("c", "set -e\nrm -rf /tmp/x"),
    result("c", ""),
    call("d", "rg TODO"),
    result("d", "Blocked by the user through bash-guard."),
    call("e", "ls"),
    result("e", ""),
  ];
  // A fork copies the history of its parent.
  const decisions = [...inferDecisions(session), ...inferDecisions(session)];
  assert.equal(
    formatReport(decisions, 2, ["/s/broken.jsonl: malformed session line 3"]),
    [
      "bash-guard decisions in 2 sessions from 2026-10-02 to 2026-10-02, read from tool results:",
      "Commands the current policy asks about: 1 ran, 1 rejected",
      "Complex commands it now blocks: 1 ran, 0 rejected",
      "Commands it no longer flags: 0 ran, 1 rejected",
      "By reason:",
      "  rm deletes files: 1 ran, 0 rejected",
      "  git rebase changes repository state: 0 ran, 1 rejected",
      "Your rejection reasons:",
      '  "not now" for git rebase main',
      '"Ran" also counts sessions without bash-guard and commands an older policy did not flag.',
      "Sessions that could not be read (1):",
      "  /s/broken.jsonl: malformed session line 3",
    ].join("\n"),
  );
});

test("/bash-guard completes stats and explains its usage", async () => {
  let name = "";
  let command:
    | {
        getArgumentCompletions(prefix: string): Array<{ label: string }> | null;
        handler(args: string, ctx: unknown): Promise<void>;
      }
    | undefined;
  registerBashGuardCommand({
    registerCommand: (registered: string, options: typeof command) => {
      name = registered;
      command = options;
    },
  } as unknown as ExtensionAPI);
  assert.equal(name, "bash-guard");
  assert.deepEqual(
    command?.getArgumentCompletions("st")?.map((item) => item.label),
    ["stats"],
  );
  assert.equal(command?.getArgumentCompletions("x"), null);

  const notices: string[] = [];
  const ctx = { ui: { notify: (message: string) => notices.push(message) } };
  await command?.handler("", ctx);
  await command?.handler("status", ctx);
  assert.deepEqual(notices, [
    "Usage: /bash-guard stats",
    "Usage: /bash-guard stats",
  ]);
});
