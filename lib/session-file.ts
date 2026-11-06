import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ParsedSession = {
  cwd?: string;
  id?: string;
  parentSession?: string;
  entries: SessionEntry[];
};

/**
 * Read-only JSONL parse of one session file. SessionManager.open would
 * migrate pre-current-version sessions and rewrite them on disk, which a
 * history scan must never do; it also sanitizes malformed lines away instead
 * of reporting them.
 */
export function parseSessionFile(raw: string, strict = false): ParsedSession {
  const lines = raw.split("\n");
  const entries: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial final line is expected while another process appends.
      if (!strict && index === lines.length - 1) continue;
      throw new Error(`malformed session line ${index + 1}`);
    }
  }

  const header = entries[0] as
    | { type?: unknown; cwd?: unknown; id?: unknown; parentSession?: unknown }
    | undefined;
  if (header?.type !== "session") {
    throw new Error("not a pi session file");
  }
  if (strict) {
    for (const [index, entry] of entries.slice(1).entries()) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { type?: unknown }).type !== "string"
      )
        throw new Error(`invalid session entry ${index + 2}`);
      if ((entry as { type: string }).type === "message") {
        const message = (entry as { message?: unknown }).message;
        if (
          typeof message !== "object" ||
          message === null ||
          typeof (message as { role?: unknown }).role !== "string"
        ) {
          throw new Error(`invalid session message ${index + 2}`);
        }
      }
    }
  }
  return {
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    id: typeof header.id === "string" ? header.id : undefined,
    parentSession:
      typeof header.parentSession === "string"
        ? header.parentSession
        : undefined,
    entries: entries.slice(1) as SessionEntry[],
  };
}
