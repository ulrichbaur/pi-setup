import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readDecisions } from "../../../extensions/bash-guard/decisions.ts";
import bashGuard from "../../../extensions/bash-guard/index.ts";

// Every harness records into its own log here, never the user's agent directory.
const logs = mkdtempSync(join(tmpdir(), "bash-guard-decisions-"));
after(() => rmSync(logs, { recursive: true, force: true }));

type ToolCallHandler = (
  event: {
    type: "tool_call";
    toolName: string;
    toolCallId: string;
    input: { command: string };
  },
  ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

function createGuardHarness(
  autoAllow = false,
  decisionsPath = join(logs, `${randomUUID()}.jsonl`),
) {
  let handler: ToolCallHandler | undefined;
  let flagName: string | undefined;
  const pi = {
    registerFlag(name: string) {
      flagName = name;
    },
    getFlag(name: string) {
      assert.equal(name, "bash-guard-auto-allow");
      return autoAllow;
    },
    registerCommand() {},
    on(event: string, registered: ToolCallHandler) {
      assert.equal(event, "tool_call");
      handler = registered;
    },
  } as unknown as ExtensionAPI;
  bashGuard(pi, decisionsPath);
  assert.equal(flagName, "bash-guard-auto-allow");
  assert.ok(handler);
  return handler;
}

function bashCall(command: string) {
  return {
    type: "tool_call" as const,
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command },
  };
}

test("bash-guard fails closed when confirmation is unavailable", async () => {
  const handler = createGuardHarness();
  const context = {
    hasUI: false,
    mode: "print",
  } as ExtensionContext;

  assert.equal(await handler(bashCall("git status"), context), undefined);
  assert.match(
    (await handler(bashCall("rm file.txt"), context))?.reason ?? "",
    /confirmation is unavailable/,
  );
});

test("bash-guard honors explicit non-interactive auto-allow", async () => {
  const handler = createGuardHarness(true);
  const context = {
    hasUI: false,
    mode: "print",
  } as ExtensionContext;
  assert.equal(await handler(bashCall("rm file.txt"), context), undefined);
});

test("bash-guard uses RPC confirmation and remembers an abort", async () => {
  const handler = createGuardHarness();
  let confirmations = 0;
  const context = {
    hasUI: true,
    mode: "rpc",
    ui: {
      async confirm() {
        confirmations += 1;
        return false;
      },
      async input() {
        return "  do not change the release commit  ";
      },
    },
  } as unknown as ExtensionContext;

  assert.match(
    (await handler(bashCall("git rebase main"), context))?.reason ?? "",
    /Blocked by the user/,
  );
  assert.match(
    (await handler(bashCall("git rebase main"), context))?.reason ?? "",
    /do not change the release commit/,
  );
  assert.match(
    (await handler(bashCall("git  rebase   main"), context))?.reason ?? "",
    /aborted recently/,
  );
  assert.match(
    (await handler(bashCall("git rebase main"), context))?.reason ?? "",
    /do not change the release commit/,
  );
  assert.equal(confirmations, 1);
});

test("bash-guard allows aborting without a reject reason", async () => {
  const handler = createGuardHarness();
  const context = {
    hasUI: true,
    mode: "rpc",
    ui: {
      confirm: async () => false,
      input: async () => "   ",
    },
  } as unknown as ExtensionContext;

  const result = await handler(bashCall("rm file.txt"), context);
  assert.match(result?.reason ?? "", /Blocked by the user/);
  assert.doesNotMatch(result?.reason ?? "", /rejection reason/);
});

test("bash-guard allows an interactively confirmed command", async () => {
  const handler = createGuardHarness();
  let message = "";
  const context = {
    hasUI: true,
    mode: "rpc",
    ui: {
      async confirm(_title: string, shown: string) {
        message = shown;
        return true;
      },
    },
  } as unknown as ExtensionContext;
  assert.equal(
    await handler(bashCall("ls && rm file.txt"), context),
    undefined,
  );
  assert.equal(
    message,
    "• rm file.txt\n  rm deletes files\n\nCommand:\nls && rm file.txt",
  );
});

test("bash-guard blocks a complex command with a risky step and names it", async () => {
  const handler = createGuardHarness();
  let asked = 0;
  const context = {
    hasUI: true,
    mode: "rpc",
    ui: {
      async confirm() {
        asked += 1;
        return true;
      },
    },
  } as unknown as ExtensionContext;

  const reason =
    (await handler(bashCall("set -e\nrm -rf /tmp/t\nmkdir /tmp/t"), context))
      ?.reason ?? "";
  assert.match(reason, /too complex to review/);
  assert.match(reason, /• rm -rf \/tmp\/t\n {2}rm -r performs recursive/);
  assert.match(reason, /its own simple command/);
  assert.equal(asked, 0);

  assert.equal(
    await handler(bashCall("set -e\nmkdir /tmp/t\nls /tmp/t"), context),
    undefined,
  );
});

test("every decision is recorded with its findings", async () => {
  const path = join(logs, "recorded.jsonl");
  const handler = createGuardHarness(false, path);
  let approve = false;
  const context = {
    hasUI: true,
    mode: "rpc",
    ui: {
      confirm: async () => approve,
      input: async () => "not now",
    },
  } as unknown as ExtensionContext;

  await handler(bashCall("git rebase main"), context);
  await handler(bashCall("git rebase main"), context);
  approve = true;
  await handler(bashCall("rm notes.txt"), context);
  await handler(bashCall("ls\nrm -rf build"), context);
  await handler(bashCall("ls"), context);

  const recorded = readDecisions(path)?.records.map(
    ({ outcome, findings, rejectReason }) => ({
      outcome,
      steps: findings.map((finding) => finding.command),
      rejectReason,
    }),
  );
  assert.deepEqual(recorded, [
    {
      outcome: "rejected",
      steps: ["git rebase main"],
      rejectReason: "not now",
    },
    { outcome: "repeat", steps: ["git rebase main"], rejectReason: undefined },
    { outcome: "ran", steps: ["rm notes.txt"], rejectReason: undefined },
    { outcome: "blocked", steps: ["rm -rf build"], rejectReason: undefined },
  ]);
});

test("a decision that cannot be recorded warns and still decides", async () => {
  const notices: string[] = [];
  // A path below a file cannot be created.
  const handler = createGuardHarness(false, "/dev/null/decisions.jsonl");
  const context = {
    hasUI: true,
    mode: "rpc",
    ui: {
      confirm: async () => true,
      notify: (message: string) => notices.push(message),
    },
  } as unknown as ExtensionContext;
  assert.equal(await handler(bashCall("rm notes.txt"), context), undefined);
  assert.match(notices[0] ?? "", /could not record a decision in \/dev\/null/);
});
