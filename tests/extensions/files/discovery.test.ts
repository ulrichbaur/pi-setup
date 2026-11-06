import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverFiles } from "../../../extensions/files/discovery.ts";
import { withTempDir } from "../../helpers.ts";

const execute = promisify(execFile);
const pi = {
  async exec(command: string, args: string[], options: { cwd: string }) {
    try {
      const result = await execute(command, args, {
        cwd: options.cwd,
        env: { ...process.env, LC_ALL: "C" },
      });
      return { ...result, code: 0, killed: false };
    } catch (error) {
      const result = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.message,
        code: result.code,
        killed: false,
      };
    }
  },
} as Pick<ExtensionAPI, "exec">;

test("Git lists tracked and nonignored untracked files, with dirty files first", async () => {
  await withTempDir("files-discovery-", async (cwd) => {
    const git = (...args: string[]) => pi.exec("git", args, { cwd });
    await git("init", "-q");
    await writeFile(join(cwd, ".gitignore"), "ignored/\n");
    await writeFile(join(cwd, "clean.ts"), "clean");
    await writeFile(join(cwd, "dirty.ts"), "before");
    await writeFile(join(cwd, "deleted.ts"), "gone");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "init",
    );
    await writeFile(join(cwd, "dirty.ts"), "after");
    await unlink(join(cwd, "deleted.ts"));
    await mkdir(join(cwd, "nested"));
    await writeFile(join(cwd, "nested", "new.ts"), "new");
    await mkdir(join(cwd, "ignored"));
    await writeFile(join(cwd, "ignored", "secret"), "ignored");
    const files = await discoverFiles(pi, cwd);
    assert.deepEqual(
      files.map((file) => [file.displayPath, file.status]),
      [
        ["deleted.ts", "D"],
        ["dirty.ts", "M"],
        ["nested/new.ts", "??"],
        [".gitignore", undefined],
        ["clean.ts", undefined],
      ],
    );
    const fromSubdir = await discoverFiles(pi, join(cwd, "nested"));
    assert.equal(fromSubdir.length, files.length);
    assert.ok(files.every((file) => !file.isDirectory));
  });
});

test("non-Git directories recursively include hidden and ignored files, without following directory symlinks", async () => {
  await withTempDir("files-local-", async (cwd) => {
    await writeFile(join(cwd, "normal.txt"), "normal");
    await writeFile(join(cwd, ".gitignore"), "hidden/\n");
    await mkdir(join(cwd, ".hidden"));
    await writeFile(join(cwd, ".hidden", "file.txt"), "hidden");
    await mkdir(join(cwd, "hidden"));
    await writeFile(join(cwd, "hidden", "file.txt"), "ignored");
    await symlink("normal.txt", join(cwd, "alias.txt"));
    await symlink("missing", join(cwd, "dangling"));
    await symlink(cwd, join(cwd, "loop"));
    await symlink("/dev/null", join(cwd, "device"));
    await execute("mkfifo", [join(cwd, "pipe")]);
    const files = await discoverFiles(pi, cwd);
    assert.deepEqual(
      files.map((file) => file.displayPath),
      [
        ".gitignore",
        ".hidden/file.txt",
        "alias.txt",
        "dangling",
        "hidden/file.txt",
        "normal.txt",
      ],
    );
    assert.equal(
      files.find((file) => file.displayPath === "alias.txt")?.canonicalPath,
      join(cwd, "alias.txt"),
    );
  });
});

test("Git symlink entries retain their own paths and exclude directories and devices", async () => {
  await withTempDir("files-links-", async (cwd) => {
    await pi.exec("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "file.txt"), "text");
    await mkdir(join(cwd, "directory"));
    await symlink("file.txt", join(cwd, "alias.txt"));
    await symlink("directory", join(cwd, "directory-link"));
    await symlink("/dev/null", join(cwd, "device"));
    await pi.exec("git", ["add", "."], { cwd });
    assert.deepEqual(
      (await discoverFiles(pi, cwd)).map((file) => file.displayPath),
      ["alias.txt", "file.txt"],
    );
  });
});

test("Git runtime errors never silently fall back to an incomplete local listing", async () => {
  const broken = (stderr: string, code = 128) =>
    ({
      exec: async () => ({ code, stdout: "", stderr, killed: false }),
    }) as Pick<ExtensionAPI, "exec">;
  await assert.rejects(
    discoverFiles(broken("permission denied"), "/project"),
    /Git discovery failed.*permission denied/,
  );
  await assert.rejects(
    discoverFiles(broken("git not installed", 1), "/project"),
    /Git discovery failed.*git not installed/,
  );
  for (const failure of ["ls-files", "status"]) {
    const fake = {
      exec: async (_command: string, args: string[]) => ({
        code: args[0] === failure ? 1 : 0,
        stdout: args[0] === "rev-parse" ? "/project" : "",
        stderr: "unavailable",
        killed: false,
      }),
    } as Pick<ExtensionAPI, "exec">;
    await assert.rejects(
      discoverFiles(fake, "/project"),
      /Git .*failed.*unavailable/,
    );
  }
});
