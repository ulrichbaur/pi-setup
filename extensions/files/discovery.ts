import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PickerFile } from "./picker.ts";
import { formatDisplayPath, parseGitStatusOutput } from "./utils.ts";

/** Includes file symlinks by their own path, without traversing directory links. */
async function isFile(file: string, deleted = false): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      try {
        return (await stat(file)).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
    }
    return info.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return deleted;
    throw error;
  }
}

async function localFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await localFiles(file)));
    else files.push(file);
  }
  return files;
}

/** Uses Git membership when available, otherwise walks the working directory. */
export async function discoverFiles(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
): Promise<PickerFile[]> {
  const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  let candidates: string[];
  const statuses = new Map<string, string>();
  if (root.code !== 0) {
    if (root.code !== 128 || !/not a git repository/i.test(root.stderr)) {
      throw new Error(
        `Git discovery failed in ${cwd}: ${root.stderr.trim() || `exit ${root.code}`}`,
      );
    }
    candidates = await localFiles(cwd);
  } else {
    const gitRoot = root.stdout.trim();
    if (!gitRoot) throw new Error(`Git returned no repository root for ${cwd}`);
    const listed = await pi.exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: gitRoot },
    );
    if (listed.code !== 0)
      throw new Error(
        `Git file listing failed in ${gitRoot}: ${listed.stderr.trim() || `exit ${listed.code}`}`,
      );
    const status = await pi.exec(
      "git",
      ["status", "--porcelain=1", "-z", "--untracked-files=all"],
      { cwd: gitRoot },
    );
    if (status.code !== 0)
      throw new Error(
        `Git status failed in ${gitRoot}: ${status.stderr.trim() || `exit ${status.code}`}`,
      );
    for (const record of parseGitStatusOutput(status.stdout)) {
      statuses.set(
        path.resolve(gitRoot, record.path),
        record.status.replace(/\s/g, ""),
      );
    }
    candidates = [
      ...new Set([
        ...listed.stdout
          .split("\0")
          .filter(Boolean)
          .map((file) => path.resolve(gitRoot, file)),
        ...statuses.keys(),
      ]),
    ];
  }
  const files: PickerFile[] = [];
  for (const file of candidates) {
    const status = statuses.get(file);
    if (!(await isFile(file, status?.includes("D")))) continue;
    files.push({
      canonicalPath: file,
      displayPath: formatDisplayPath(file, cwd),
      isDirectory: false,
      ...(status ? { status } : {}),
    });
  }
  return files.sort(
    (a, b) =>
      Number(Boolean(b.status)) - Number(Boolean(a.status)) ||
      a.displayPath.localeCompare(b.displayPath),
  );
}
