import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ParsedSession = { cwd?: string; entries: SessionEntry[] };

/**
 * Read-only JSONL parse of one session file. SessionManager.open would
 * migrate pre-current-version sessions and rewrite them on disk, which a
 * history scan must never do; it also sanitizes malformed lines away instead
 * of reporting them.
 */
export function parseSessionFile(raw: string): ParsedSession {
  const lines = raw.split("\n");
  const entries: unknown[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial final line is expected while another process appends.
      if (index === lines.length - 1) continue;
      throw new Error(`malformed session line ${index + 1}`);
    }
  }

  const header = entries[0] as { type?: unknown; cwd?: unknown } | undefined;
  if (header?.type !== "session") {
    throw new Error("not a pi session file");
  }
  return {
    cwd: typeof header.cwd === "string" ? header.cwd : undefined,
    entries: entries.slice(1) as SessionEntry[],
  };
}
