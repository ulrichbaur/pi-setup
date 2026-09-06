import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import bashGuard from "../../../extensions/bash-guard/index.ts";

type ToolCallHandler = (
  event: {
    type: "tool_call";
    toolName: string;
    toolCallId: string;
    input: { command: string };
  },
  ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

function createGuardHarness(autoAllow = false) {
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
    on(event: string, registered: ToolCallHandler) {
      assert.equal(event, "tool_call");
      handler = registered;
    },
  } as unknown as ExtensionAPI;
  bashGuard(pi);
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
  const context = {
    hasUI: true,
    mode: "rpc",
    ui: { confirm: async () => true },
  } as unknown as ExtensionContext;
  assert.equal(await handler(bashCall("rm file.txt"), context), undefined);
});
