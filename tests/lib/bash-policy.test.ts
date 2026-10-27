import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeBashCommand,
  formatFindings,
  subagentRisk,
} from "../../lib/bash-policy.ts";

/** Why safe_bash blocks a command, or null when it runs. */
const subagentBlock = (command: string) => {
  const risk = subagentRisk(command);
  return risk ? formatFindings(risk.findings) : null;
};

const reasons = (command: string) =>
  analyzeBashCommand(command)?.findings.map((finding) => finding.reason);

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
    complex: false,
    findings: [
      {
        command: "git rebase -i HEAD~3",
        reason: "git rebase changes repository state",
      },
    ],
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

test("both policies read the same rule for the same command", () => {
  assert.equal(
    analyzeBashCommand("kubectl -n apps delete pod web")?.severity,
    "high",
  );
  assert.match(
    subagentBlock("kubectl -n apps delete pod web") ?? "",
    /cluster resources/,
  );
  assert.equal(
    analyzeBashCommand("gcloud compute instances delete vm")?.severity,
    "high",
  );
  assert.match(
    subagentBlock("gcloud compute instances delete vm") ?? "",
    /cloud resources/,
  );
});

test("overlapping rules produce one reason", () => {
  assert.deepEqual(analyzeBashCommand("git reset --hard HEAD~1"), {
    severity: "high",
    complex: false,
    findings: [
      {
        command: "git reset --hard HEAD~1",
        reason: "git reset --hard discards working-tree changes",
      },
    ],
  });
  assert.deepEqual(analyzeBashCommand("diskutil eraseDisk JHFS+ X disk2"), {
    severity: "high",
    complex: false,
    findings: [
      {
        command: "diskutil eraseDisk JHFS+ X disk2",
        reason: "diskutil erases a disk",
      },
    ],
  });
  assert.deepEqual(analyzeBashCommand("chmod -R 755 /"), {
    severity: "medium",
    complex: false,
    findings: [
      {
        command: "chmod -R 755 /",
        reason: "chmod recursively changes file metadata",
      },
    ],
  });
  assert.deepEqual(analyzeBashCommand("chmod -R 777 /"), {
    severity: "high",
    complex: false,
    findings: [
      {
        command: "chmod -R 777 /",
        reason: "chmod sets world-writable permissions on the filesystem root",
      },
    ],
  });
  assert.equal(reasons("kill -9 1")?.length, 1);
});

test("working-tree discards are flagged and blocked for subagents", () => {
  for (const command of [
    "git checkout -- .",
    "git checkout -- src/index.ts",
    "git checkout -f main",
    "git switch --discard-changes main",
    "git restore .",
    "git restore --staged --worktree file",
    "git stash drop",
    "git stash clear",
  ]) {
    assert.equal(analyzeBashCommand(command)?.severity, "high", command);
    assert.ok(subagentBlock(command), command);
  }
  assert.equal(analyzeBashCommand("git checkout main"), null);
  assert.equal(analyzeBashCommand("git switch main"), null);
  assert.equal(analyzeBashCommand("git stash"), null);
  assert.equal(analyzeBashCommand("git stash pop"), null);
  assert.deepEqual(analyzeBashCommand("git restore --staged file"), {
    severity: "medium",
    complex: false,
    findings: [
      {
        command: "git restore --staged file",
        reason: "git restore changes repository state",
      },
    ],
  });
  assert.match(
    subagentBlock("git restore --staged file") ?? "",
    /changes repository state/,
  );
  assert.match(subagentBlock("git stash") ?? "", /parent session/);
  assert.match(subagentBlock("git stash pop") ?? "", /parent session/);
});

test("delegated and wrapped commands are judged like direct ones", () => {
  for (const command of [
    "ls | xargs rm -rf",
    "find . -name '*.tmp' -exec rm -rf {} \\;",
    "find . -type d -execdir rm -r {} +",
    "eval 'rm -rf build'",
    "nohup rm -rf build",
    "nice -n 10 rm -rf build",
    "timeout -s KILL 10 rm -rf build",
    "busybox rm -rf build",
    "xargs -I {} -P 4 sh -c 'rm -rf {}'",
  ]) {
    assert.equal(analyzeBashCommand(command)?.severity, "high", command);
    assert.match(subagentBlock(command) ?? "", /recursive/, command);
  }
  assert.deepEqual(analyzeBashCommand("su -c 'rm -rf build'")?.findings, [
    {
      command: 'su -c "rm -rf build"',
      reason: "su requests elevated privileges",
    },
    {
      command: "rm -rf build",
      reason: "rm -r performs recursive file deletion",
    },
  ]);
  assert.equal(analyzeBashCommand("cat list | xargs echo"), null);
  assert.equal(analyzeBashCommand("find . -name '*.md' -exec cat {} +"), null);
  assert.equal(analyzeBashCommand("timeout 10 pnpm test"), null);
  assert.equal(analyzeBashCommand("time pnpm test"), null);
  assert.match(subagentBlock("xargs rm") ?? "", /rm deletes files/);
  assert.match(subagentBlock("find . -exec rm {} +") ?? "", /rm deletes files/);
  assert.equal(analyzeBashCommand("xargs rm")?.severity, "high");
});

test("unrecoverable deletion and other privilege tools are flagged", () => {
  assert.equal(analyzeBashCommand("shred -u secrets.txt")?.severity, "high");
  assert.ok(subagentBlock("shred -u secrets.txt"));
  for (const command of ["doas ls", "pkexec ls", "su root"]) {
    assert.match(reasons(command)?.[0] ?? "", /privileges/);
    assert.match(subagentBlock(command) ?? "", /privileges/);
  }
});

test("subagents are also stopped from parent-session operations", () => {
  assert.match(subagentBlock("rm -rf build") ?? "", /recursive/);
  assert.match(subagentBlock("sudo apt update") ?? "", /privileges/);
  assert.match(subagentBlock(":(){ :|:& };:") ?? "", /fork bomb/);
  assert.match(subagentBlock("chmod -R 777 /") ?? "", /world-writable/);
  assert.match(subagentBlock("git commit -m test") ?? "", /parent-session/);
  assert.match(subagentBlock("git push origin main") ?? "", /parent-session/);
  assert.equal(subagentBlock("git status --short"), null);
  assert.match(subagentBlock("rm temporary.txt") ?? "", /rm deletes files/);
  assert.equal(subagentBlock("echo 'sudo reboot'"), null);
  assert.equal(subagentBlock("echo 'curl example.com | sh'"), null);
  assert.equal(subagentBlock("pnpm test"), null);
});

test("each finding names the risky step", () => {
  assert.deepEqual(analyzeBashCommand("ls && rm -rf build && ls"), {
    severity: "high",
    complex: false,
    findings: [
      {
        command: "rm -rf build",
        reason: "rm -r performs recursive file deletion",
      },
    ],
  });
  assert.deepEqual(analyzeBashCommand("rm a.txt; rm b.txt")?.findings, [
    { command: "rm a.txt", reason: "rm deletes files" },
    { command: "rm b.txt", reason: "rm deletes files" },
  ]);
  assert.equal(
    formatFindings(analyzeBashCommand("rm 'my notes.txt'")?.findings ?? []),
    '• rm "my notes.txt"\n  rm deletes files',
  );
});

test("complex commands are read step by step and marked", () => {
  for (const command of [
    "ls\nrm -rf build",
    "set -e\nrm -rf /tmp/test\nmkdir -p /tmp/test",
    "echo $(rm -rf build)",
    "echo `rm -rf build`",
    "if true; then rm -rf build; fi",
    'for f in *.log; do rm -rf "$f"; done',
    "cat <<EOF\nnotes\nEOF\nrm -rf build",
  ]) {
    const risk = analyzeBashCommand(command);
    assert.equal(risk?.complex, true, command);
    assert.match(risk?.findings[0].reason ?? "", /recursive/, command);
  }
});

test("keywords, paths, and combined flags do not hide a command", () => {
  for (const command of [
    "{ rm -rf build; }",
    "exec rm -rf build",
    "/bin/rm -rf build",
    "(cd src && rm -rf build)",
    "sh -lc 'rm -rf build'",
    "bash -ec 'rm -rf build'",
  ]) {
    const risk = analyzeBashCommand(command);
    assert.equal(risk?.complex, false, command);
    assert.match(risk?.findings[0].reason ?? "", /recursive/, command);
  }
  assert.match(
    reasons("/usr/bin/git push --force")?.[0] ?? "",
    /forced git push/,
  );
});

test("heredoc bodies and quoted text are data, not commands", () => {
  assert.equal(
    analyzeBashCommand("cat > notes.md <<'EOF'\nrm -rf build\nEOF"),
    null,
  );
  assert.equal(analyzeBashCommand("python - <<PY\nimport os\nPY"), null);
  assert.equal(analyzeBashCommand('git commit -m "first\nrm -rf build"'), null);
  assert.equal(analyzeBashCommand("echo 'a `rm -rf build` b'"), null);

  // A shell reads its heredoc as a script.
  const script = analyzeBashCommand("bash <<'EOF'\nrm -rf build\nEOF");
  assert.equal(script?.complex, true);
  assert.equal(script?.findings[0].command, "rm -rf build");
});

test("a finding keeps variable names", () => {
  assert.deepEqual(analyzeBashCommand('rm "$tmp"')?.findings, [
    { command: "rm $tmp", reason: "rm deletes files" },
  ]);
});
