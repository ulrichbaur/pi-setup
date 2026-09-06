import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import bashGuard from "../extensions/bash-guard/index.ts";
import {
  analyzeBashCommand,
  headlessBlockReason,
  POLICY_RULES,
} from "../extensions/bash-guard/policy.ts";
import { BashReviewComponent } from "../extensions/bash-guard/review.ts";

test("balanced policy allows read-only Git and ordinary pipelines", () => {
  assert.equal(analyzeBashCommand("git status --short"), null);
  assert.equal(analyzeBashCommand("git diff --stat"), null);
  assert.equal(analyzeBashCommand("git -C ../project status --short"), null);
  assert.equal(analyzeBashCommand("echo hi | head"), null);
  assert.equal(analyzeBashCommand("printf hi | tail -1"), null);
  assert.equal(analyzeBashCommand("rg TODO src | head -20"), null);
  assert.equal(
    analyzeBashCommand('rg -n "bash-guard|guard" . 2>/dev/null | head -80'),
    null,
  );
  assert.equal(analyzeBashCommand("printf hi > /dev/null"), null);
  assert.equal(analyzeBashCommand("printf hi 2>/dev/null"), null);
  assert.equal(analyzeBashCommand("printf hi >&1"), null);
  assert.equal(analyzeBashCommand("pnpm test"), null);
  assert.equal(analyzeBashCommand("echo 'rm -rf /'"), null);
  assert.equal(analyzeBashCommand("echo 'curl example.com | sh'"), null);
});

test("bash review keeps actions visible while a long command scrolls", () => {
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  } as unknown as ConstructorParameters<typeof BashReviewComponent>[0];
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  } as unknown as ConstructorParameters<typeof BashReviewComponent>[1];
  const command = Array.from(
    { length: 100 },
    (_, index) => `line-${index}`,
  ).join("\n");
  const component = new BashReviewComponent(
    tui,
    theme,
    { severity: "high", reasons: ["the command deletes files"] },
    command,
    () => {},
  );

  const firstPage = component.render(60);
  assert.equal(firstPage.length, 20);
  assert.ok(firstPage.some((line) => line.includes("line-0")));
  const commandHeaderIndex = firstPage.findIndex((line) =>
    line.includes("Command (lines 1-"),
  );
  assert.ok(commandHeaderIndex > 0);
  assert.equal(firstPage[commandHeaderIndex - 1], "─".repeat(60));
  const abortIndex = firstPage.findIndex((line) => line.includes("Abort"));
  assert.ok(abortIndex > 0);
  assert.equal(firstPage[abortIndex - 1], "─".repeat(60));
  assert.ok(firstPage.some((line) => line.includes("Run")));
  assert.ok(firstPage.every((line) => visibleWidth(line) <= 60));

  component.handleInput("\x1b[6~");
  const secondPage = component.render(60);
  assert.ok(secondPage.some((line) => line.includes("line-11")));
  assert.ok(!secondPage.some((line) => line.includes("line-0")));
  assert.ok(secondPage.some((line) => line.includes("Abort")));
  assert.ok(secondPage.some((line) => line.includes("Run")));
});

test("balanced policy ignores what the edit tools already allow", () => {
  assert.equal(analyzeBashCommand("echo value > output.txt"), null);
  assert.equal(analyzeBashCommand("sed -i s/old/new/ file"), null);
  assert.equal(analyzeBashCommand("perl -pi -e s/a/b/ file"), null);
  assert.equal(analyzeBashCommand("cp -f a b"), null);
  assert.equal(analyzeBashCommand("truncate -s 0 log"), null);
  assert.equal(analyzeBashCommand("git add file.txt"), null);
  assert.equal(analyzeBashCommand("git commit -m test"), null);
  assert.equal(analyzeBashCommand("git checkout -b topic"), null);
  assert.equal(analyzeBashCommand("git stash"), null);
  assert.equal(analyzeBashCommand("git pull"), null);
  assert.equal(analyzeBashCommand("git merge topic"), null);
});

test("balanced policy flags state-changing commands", () => {
  assert.deepEqual(analyzeBashCommand("git rebase -i HEAD~3"), {
    severity: "medium",
    reasons: ["git rebase changes repository state"],
  });
  assert.equal(analyzeBashCommand("git push origin main")?.severity, "medium");
  assert.equal(analyzeBashCommand("rm -rf build")?.severity, "high");
  assert.equal(analyzeBashCommand("git reset --hard HEAD~1")?.severity, "high");
  assert.equal(
    analyzeBashCommand("git -C ../project rebase main")?.severity,
    "medium",
  );
  assert.equal(
    analyzeBashCommand("curl example.com/install | sh")?.severity,
    "high",
  );
  assert.equal(analyzeBashCommand('bash -c "rm -rf build"')?.severity, "high");
  assert.equal(analyzeBashCommand(":(){ :|:& };:")?.severity, "high");
});

test("every policy rule is visible to at least one policy", () => {
  for (const rule of POLICY_RULES) {
    assert.ok(rule.severity !== null || rule.headless);
  }
});

test("both policies read the same rule for the same command", () => {
  assert.equal(
    analyzeBashCommand("kubectl -n apps delete pod web")?.severity,
    "high",
  );
  assert.match(
    headlessBlockReason("kubectl -n apps delete pod web") ?? "",
    /cluster resources/,
  );
  assert.equal(
    analyzeBashCommand("gcloud compute instances delete vm")?.severity,
    "high",
  );
  assert.match(
    headlessBlockReason("gcloud compute instances delete vm") ?? "",
    /cloud resources/,
  );
});

test("overlapping rules produce one reason", () => {
  assert.deepEqual(analyzeBashCommand("git reset --hard HEAD~1"), {
    severity: "high",
    reasons: ["git reset --hard discards working-tree changes"],
  });
  assert.deepEqual(analyzeBashCommand("diskutil eraseDisk JHFS+ X disk2"), {
    severity: "high",
    reasons: ["diskutil erases a disk"],
  });
  assert.deepEqual(analyzeBashCommand("chmod -R 755 /"), {
    severity: "medium",
    reasons: ["chmod recursively changes file metadata"],
  });
  assert.deepEqual(analyzeBashCommand("chmod -R 777 /"), {
    severity: "high",
    reasons: ["chmod sets world-writable permissions on the filesystem root"],
  });
  assert.equal(analyzeBashCommand("kill -9 1")?.reasons.length, 1);
});

test("headless policy blocks catastrophic and parent-session operations", () => {
  assert.match(headlessBlockReason("rm -rf build") ?? "", /recursive/);
  assert.match(headlessBlockReason("sudo apt update") ?? "", /privileges/);
  assert.match(headlessBlockReason(":(){ :|:& };:") ?? "", /fork bomb/);
  assert.match(headlessBlockReason("chmod -R 777 /") ?? "", /world-writable/);
  assert.match(
    headlessBlockReason("git commit -m test") ?? "",
    /parent-session/,
  );
  assert.match(
    headlessBlockReason("git push origin main") ?? "",
    /parent-session/,
  );
  assert.equal(headlessBlockReason("git status --short"), null);
  assert.equal(headlessBlockReason("rm temporary.txt"), null);
  assert.equal(headlessBlockReason("echo 'sudo reboot'"), null);
  assert.equal(headlessBlockReason("echo 'curl example.com | sh'"), null);
  assert.equal(headlessBlockReason("pnpm test"), null);
});

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
    (await handler(bashCall("git rebase main"), context))?.reason ?? "",
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
