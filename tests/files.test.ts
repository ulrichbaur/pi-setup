import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  collectSessionFileChanges,
  extractFileReferencesFromContent,
  extractFileReferencesFromEntry,
  extractFileReferencesFromText,
  extractPathsFromToolArgs,
  formatDisplayPath,
  normalizeReferencePath,
  parseGitStatusOutput,
  sanitizeReference,
  stripLineSuffix,
  toCanonicalPath,
} from "../extensions/files/utils.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "files-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function initGitRepo(dir: string): (...args: string[]) => string {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  return git;
}

// =============================================================================
// extractFileReferencesFromText
// =============================================================================

test("extractFileReferencesFromText — <file name> tags", () => {
  // Both FILE_TAG_REGEX and PATH_REGEX fire on the path inside the tag;
  // deduplication happens later in collectRecentFileReferences via a Set.
  const refs = extractFileReferencesFromText(
    "see <file name=\"/home/user/src/foo.ts\"> and <file name='/etc/hosts'>",
  );
  assert.ok(refs.includes("/home/user/src/foo.ts"));
  assert.ok(refs.includes("/etc/hosts"));
});

test("extractFileReferencesFromText — file:// URIs", () => {
  const refs = extractFileReferencesFromText(
    "open file:///home/user/readme.md for details",
  );
  assert.deepEqual(refs, ["file:///home/user/readme.md"]);
});

test("extractFileReferencesFromText — absolute paths in prose", () => {
  const refs = extractFileReferencesFromText(
    "we should update /src/utils/helpers.ts and also look at ~/.config/pi.json",
  );
  assert.deepEqual(refs, ["/src/utils/helpers.ts", "~/.config/pi.json"]);
});

test("extractFileReferencesFromText — mixed formats", () => {
  // The <file name> tag path also matches PATH_REGEX, producing duplicates.
  const refs = extractFileReferencesFromText(
    '<file name="/a/b.ts"> and file:///c/d.txt and /e/f.ts',
  );
  assert.ok(refs.includes("/a/b.ts"));
  assert.ok(refs.includes("file:///c/d.txt"));
  assert.ok(refs.includes("/e/f.ts"));
});

test("extractFileReferencesFromText — no matches", () => {
  assert.deepEqual(extractFileReferencesFromText("nothing here"), []);
  assert.deepEqual(extractFileReferencesFromText(""), []);
});

// =============================================================================
// extractPathsFromToolArgs
// =============================================================================

test("extractPathsFromToolArgs — direct single-path keys", () => {
  for (const key of [
    "path",
    "file",
    "filePath",
    "filepath",
    "fileName",
    "filename",
  ]) {
    assert.deepEqual(extractPathsFromToolArgs({ [key]: `/tmp/${key}.ts` }), [
      `/tmp/${key}.ts`,
    ]);
  }
});

test("extractPathsFromToolArgs — array keys", () => {
  for (const key of ["paths", "files", "filePaths"]) {
    assert.deepEqual(extractPathsFromToolArgs({ [key]: ["/a.ts", "/b.ts"] }), [
      "/a.ts",
      "/b.ts",
    ]);
  }
});

test("extractPathsFromToolArgs — non-object / null / undefined", () => {
  assert.deepEqual(extractPathsFromToolArgs(null), []);
  assert.deepEqual(extractPathsFromToolArgs(undefined), []);
  assert.deepEqual(extractPathsFromToolArgs("just a string"), []);
  assert.deepEqual(extractPathsFromToolArgs(42), []);
});

test("extractPathsFromToolArgs — ignores non-string array items", () => {
  assert.deepEqual(
    extractPathsFromToolArgs({ paths: ["/a.ts", 42, null, "/b.ts"] }),
    ["/a.ts", "/b.ts"],
  );
});

test("extractPathsFromToolArgs — empty object", () => {
  assert.deepEqual(extractPathsFromToolArgs({}), []);
});

// =============================================================================
// extractFileReferencesFromContent
// =============================================================================

test("extractFileReferencesFromContent — plain string", () => {
  assert.deepEqual(extractFileReferencesFromContent("check /foo/bar.ts"), [
    "/foo/bar.ts",
  ]);
});

test("extractFileReferencesFromContent — array of text blocks", () => {
  const refs = extractFileReferencesFromContent([
    { type: "text", text: "see /a.ts" },
    { type: "text", text: "and /b.ts" },
  ]);
  assert.deepEqual(refs, ["/a.ts", "/b.ts"]);
});

test("extractFileReferencesFromContent — toolCall blocks", () => {
  const refs = extractFileReferencesFromContent([
    { type: "toolCall", name: "read", arguments: { path: "/tmp/read.ts" } },
    { type: "toolCall", name: "edit", arguments: { filePath: "/tmp/edit.ts" } },
  ]);
  assert.deepEqual(refs, ["/tmp/read.ts", "/tmp/edit.ts"]);
});

test("extractFileReferencesFromContent — mixed blocks", () => {
  const refs = extractFileReferencesFromContent([
    { type: "text", text: "start with /a.ts" },
    { type: "toolCall", name: "write", arguments: { path: "/b.ts" } },
    { type: "text", text: "end" },
  ]);
  assert.deepEqual(refs, ["/a.ts", "/b.ts"]);
});

test("extractFileReferencesFromContent — non-array, non-string", () => {
  assert.deepEqual(extractFileReferencesFromContent(42), []);
  assert.deepEqual(extractFileReferencesFromContent(null), []);
  assert.deepEqual(extractFileReferencesFromContent(true), []);
});

test("extractFileReferencesFromContent — skips non-object parts", () => {
  assert.deepEqual(
    extractFileReferencesFromContent(["plain string", 42, null]),
    [],
  );
});

// =============================================================================
// extractFileReferencesFromEntry
// =============================================================================

test("extractFileReferencesFromEntry — message entry", () => {
  const refs = extractFileReferencesFromEntry({
    type: "message",
    message: { role: "user", content: "look at /a/b.ts" },
  });
  assert.deepEqual(refs, ["/a/b.ts"]);
});

test("extractFileReferencesFromEntry — message with array content", () => {
  const refs = extractFileReferencesFromEntry({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "modified /x.ts" }],
    },
  });
  assert.deepEqual(refs, ["/x.ts"]);
});

test("extractFileReferencesFromEntry — custom_message entry", () => {
  const refs = extractFileReferencesFromEntry({
    type: "custom_message",
    content: "check /custom.ts",
  });
  assert.deepEqual(refs, ["/custom.ts"]);
});

test("extractFileReferencesFromEntry — unknown type", () => {
  assert.deepEqual(extractFileReferencesFromEntry({ type: "other" }), []);
  assert.deepEqual(extractFileReferencesFromEntry({}), []);
});

test("extractFileReferencesFromEntry — message without content", () => {
  assert.deepEqual(
    extractFileReferencesFromEntry({ type: "message", message: {} }),
    [],
  );
});

// =============================================================================
// sanitizeReference
// =============================================================================

test("sanitizeReference — strips quotes and brackets", () => {
  assert.equal(sanitizeReference('"/path/to/file.ts"'), "/path/to/file.ts");
  assert.equal(sanitizeReference("'/path/to/file.ts'"), "/path/to/file.ts");
  assert.equal(sanitizeReference("`/path/to/file.ts`"), "/path/to/file.ts");
  assert.equal(sanitizeReference("(/path/to/file.ts)"), "/path/to/file.ts");
  assert.equal(sanitizeReference("[/path/to/file.ts]"), "/path/to/file.ts");
});

test("sanitizeReference — strips trailing punctuation", () => {
  assert.equal(sanitizeReference("/path/to/file.ts,"), "/path/to/file.ts");
  assert.equal(sanitizeReference("/path/to/file.ts."), "/path/to/file.ts");
  assert.equal(sanitizeReference("/path/to/file.ts;"), "/path/to/file.ts");
  assert.equal(sanitizeReference("/path/to/file.ts:"), "/path/to/file.ts");
});

test("sanitizeReference — preserves inner special chars", () => {
  assert.equal(sanitizeReference("/path/to/file-v2.ts"), "/path/to/file-v2.ts");
  assert.equal(
    sanitizeReference("/path with spaces/file.ts"),
    "/path with spaces/file.ts",
  );
});

test("sanitizeReference — empty / whitespace-only", () => {
  assert.equal(sanitizeReference(""), "");
  assert.equal(sanitizeReference("   "), "");
});

// =============================================================================
// stripLineSuffix
// =============================================================================

test("stripLineSuffix — GitHub line suffix", () => {
  assert.equal(stripLineSuffix("/a/b.ts#L42"), "/a/b.ts");
  assert.equal(stripLineSuffix("/a/b.ts#L10C5"), "/a/b.ts");
});

test("stripLineSuffix — vim-style colon suffix", () => {
  assert.equal(stripLineSuffix("/a/b.ts:42"), "/a/b.ts");
  assert.equal(stripLineSuffix("/a/b.ts:10:5"), "/a/b.ts");
});

test("stripLineSuffix — colon after last separator", () => {
  // Only strips if colon appears in the filename segment (after last /)
  assert.equal(stripLineSuffix("src/main.ts:42"), "src/main.ts");
});

test("stripLineSuffix — no suffix", () => {
  assert.equal(stripLineSuffix("/a/b.ts"), "/a/b.ts");
  assert.equal(stripLineSuffix("/a/b/c"), "/a/b/c");
});

test("stripLineSuffix — colons in path (not line numbers)", () => {
  // Windows-style path — colon in segment before last separator, not a line number
  const result = stripLineSuffix("C:\\foo\\bar.ts");
  assert.equal(result.includes("bar.ts"), true);
});

// =============================================================================
// normalizeReferencePath
// =============================================================================

test("normalizeReferencePath — absolute path passes through", () => {
  const cwd = "/home/user/project";
  assert.equal(normalizeReferencePath("/etc/hosts", cwd), "/etc/hosts");
});

test("normalizeReferencePath — relative path resolved against cwd", () => {
  const cwd = "/home/user/project";
  assert.equal(
    normalizeReferencePath("src/main.ts", cwd),
    "/home/user/project/src/main.ts",
  );
});

test("normalizeReferencePath — tilde expansion", () => {
  const cwd = "/tmp";
  const result = normalizeReferencePath("~/documents/readme.md", cwd);
  assert.ok(result?.startsWith("/"));
  assert.ok(result?.endsWith("/documents/readme.md"));
  assert.ok(!result?.includes("~"));
});

test("normalizeReferencePath — file:// URI", () => {
  assert.equal(
    normalizeReferencePath("file:///home/user/file.txt", "/tmp"),
    "/home/user/file.txt",
  );
});

test("normalizeReferencePath — strips line suffixes inline", () => {
  assert.equal(normalizeReferencePath("/a/b.ts#L42", "/tmp"), "/a/b.ts");
});

test("normalizeReferencePath — comment-like returns null", () => {
  assert.equal(normalizeReferencePath("// not a path", "/tmp"), null);
});

test("normalizeReferencePath — empty / whitespace-only returns null", () => {
  assert.equal(normalizeReferencePath("", "/tmp"), null);
  assert.equal(normalizeReferencePath("   ", "/tmp"), null);
});

test("normalizeReferencePath — trailing slashes stripped", () => {
  assert.equal(normalizeReferencePath("/a/b/c/", "/tmp"), "/a/b/c");
});

test("normalizeReferencePath — bare file:// resolves to root", () => {
  // file:// with no authority or path is a valid file URL pointing at /
  assert.equal(normalizeReferencePath("file://", "/tmp"), "/");
});

test("normalizeReferencePath — trailing quotes stripped then resolved", () => {
  // sanitizeReference strips the quotes, then it resolves as a normal path
  assert.equal(
    normalizeReferencePath('"/home/user/file.ts"', "/tmp"),
    "/home/user/file.ts",
  );
});

// =============================================================================
// formatDisplayPath
// =============================================================================

test("formatDisplayPath — path under cwd becomes relative", () => {
  assert.equal(
    formatDisplayPath("/home/user/project/src/main.ts", "/home/user/project"),
    "src/main.ts",
  );
});

test("formatDisplayPath — path outside cwd stays absolute", () => {
  assert.equal(
    formatDisplayPath("/etc/hosts", "/home/user/project"),
    "/etc/hosts",
  );
});

test("formatDisplayPath — cwd trailing slash handled", () => {
  assert.equal(
    formatDisplayPath("/home/user/project/src/main.ts", "/home/user/project/"),
    "src/main.ts",
  );
});

// =============================================================================
// parseGitStatusOutput
// =============================================================================

test("parseGitStatusOutput — modified and untracked entries", () => {
  const records = parseGitStatusOutput(" M src/a.ts\0?? new.txt\0");
  assert.deepEqual(records, [
    { status: " M", path: "src/a.ts" },
    { status: "??", path: "new.txt" },
  ]);
});

test("parseGitStatusOutput — rename keeps the destination path", () => {
  // -z format: `R  <new>\0<old>\0` — destination first, then original path
  const records = parseGitStatusOutput("R  new.txt\0old.txt\0?? other.txt\0");
  assert.deepEqual(records, [
    { status: "R ", path: "new.txt", origPath: "old.txt" },
    { status: "??", path: "other.txt" },
  ]);
});

test("parseGitStatusOutput — copy keeps the destination path", () => {
  const records = parseGitStatusOutput("C  copy.txt\0source.txt\0");
  assert.deepEqual(records, [
    { status: "C ", path: "copy.txt", origPath: "source.txt" },
  ]);
});

test("parseGitStatusOutput — empty output", () => {
  assert.deepEqual(parseGitStatusOutput(""), []);
});

test("parseGitStatusOutput — real git repo with staged rename", () => {
  withTempDir((dir) => {
    const git = initGitRepo(dir);
    writeFileSync(path.join(dir, "old.txt"), "hello\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("mv", "old.txt", "new.txt");
    const records = parseGitStatusOutput(git("status", "--porcelain=1", "-z"));
    assert.deepEqual(records, [
      { status: "R ", path: "new.txt", origPath: "old.txt" },
    ]);
  });
});

// =============================================================================
// toCanonicalPath
// =============================================================================

test("toCanonicalPath — preserves symlink path identity", () => {
  withTempDir((dir) => {
    mkdirSync(path.join(dir, "target"));
    writeFileSync(path.join(dir, "target", "a"), "content\n");
    symlinkSync(path.join("target", "a"), path.join(dir, "link-a"));
    const result = toCanonicalPath(path.join(dir, "link-a"));
    assert.equal(result?.canonicalPath, path.join(dir, "link-a"));
    assert.equal(result?.isDirectory, false);
  });
});

test("toCanonicalPath — distinct symlinks to one target stay distinct", () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, "a"), "content\n");
    symlinkSync("a", path.join(dir, "link-1"));
    symlinkSync("a", path.join(dir, "link-2"));
    const one = toCanonicalPath(path.join(dir, "link-1"));
    const two = toCanonicalPath(path.join(dir, "link-2"));
    assert.notEqual(one?.canonicalPath, two?.canonicalPath);
  });
});

test("toCanonicalPath — tracked symlink in a real git repo", () => {
  withTempDir((dir) => {
    const git = initGitRepo(dir);
    mkdirSync(path.join(dir, "target"));
    writeFileSync(path.join(dir, "target", "a"), "content\n");
    symlinkSync(path.join("target", "a"), path.join(dir, "link-a"));
    git("add", ".");
    git("commit", "-qm", "init");
    const listed = git("ls-files", "-z").split("\0").filter(Boolean);
    assert.ok(listed.includes("link-a"));
    const canonicalPaths = listed.map(
      (rel) => toCanonicalPath(path.resolve(dir, rel)).canonicalPath,
    );
    // The symlink keeps its own Git pathname; it is not collapsed into target/a
    assert.ok(canonicalPaths.includes(path.join(dir, "link-a")));
    assert.equal(canonicalPaths.length, listed.length);
  });
});

test("toCanonicalPath — missing path is kept with exists=false", () => {
  withTempDir((dir) => {
    const missing = path.join(dir, "deleted.txt");
    assert.deepEqual(toCanonicalPath(missing), {
      canonicalPath: missing,
      isDirectory: false,
      exists: false,
    });
  });
});

// =============================================================================
// collectSessionFileChanges
// =============================================================================

function makeToolCallEntries(
  filePath: string,
  options: { isError: boolean; timestamp?: number },
): SessionEntry[] {
  return [
    {
      type: "message",
      id: "1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "edit",
            arguments: { path: filePath },
          },
        ],
      },
    },
    {
      type: "message",
      id: "2",
      parentId: "1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "edit",
        content: [],
        isError: options.isError,
        timestamp: options.timestamp ?? 1000,
      },
    },
  ] as unknown as SessionEntry[];
}

test("collectSessionFileChanges — successful edit is recorded", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "a.ts");
    writeFileSync(filePath, "content\n");
    const changes = collectSessionFileChanges(
      makeToolCallEntries(filePath, { isError: false }),
      dir,
    );
    assert.equal(changes.size, 1);
    assert.equal(changes.get(filePath)?.lastTimestamp, 1000);
  });
});

test("collectSessionFileChanges — failed edit is ignored", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "a.ts");
    writeFileSync(filePath, "content\n");
    const changes = collectSessionFileChanges(
      makeToolCallEntries(filePath, { isError: true }),
      dir,
    );
    assert.equal(changes.size, 0);
  });
});
