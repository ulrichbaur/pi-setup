import path from "node:path";

/** Paths under cwd are relative; paths elsewhere remain absolute. */
export function formatDisplayPath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? relative
    : absolutePath;
}

export type GitStatusRecord = {
  status: string;
  path: string;
  origPath?: string;
};

/** Porcelain -z rename records put the destination before the original path. */
export function parseGitStatusOutput(stdout: string): GitStatusRecord[] {
  const fields = stdout.split("\0").filter(Boolean);
  const records: GitStatusRecord[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const status = field.slice(0, 2);
    const filePath = field.slice(3);
    if (!filePath) continue;
    const record: GitStatusRecord = { status, path: filePath };
    if (/[RC]/.test(status) && fields[i + 1]) {
      record.origPath = fields[i + 1];
      i += 1;
    }
    records.push(record);
  }
  return records;
}
