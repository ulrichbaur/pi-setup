import { createReadStream } from "node:fs";
import { join } from "node:path";
import { terminalText } from "./task-store.ts";

type Match = { line: number; offset: number };

/** Find the next matching line, wrapping once. Retain only the current line and candidate matches. */
export async function findLogMatch(
  dir: string,
  query: string,
  start: number,
  direction: 1 | -1,
  signal?: AbortSignal,
): Promise<Match | undefined> {
  const stream = createReadStream(join(dir, "output.log"), { signal });
  let line = 1;
  let offset = 0;
  let length = 0;
  let parts: Buffer[] = [];
  let fallback: Match | undefined;
  let previous: Match | undefined;

  function consume(newline: boolean): Match | undefined {
    const here = { line, offset };
    if (direction === -1 && line > start && previous) return previous;
    const matches = terminalText(
      Buffer.concat(parts, length).toString("utf8"),
    ).includes(query);
    offset += length + Number(newline);
    line++;
    length = 0;
    parts = [];
    if (!matches) return undefined;
    if (direction === 1) {
      if (here.line >= start) return here;
      fallback ??= here;
    } else {
      if (here.line <= start) previous = here;
      fallback = here;
    }
  }

  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      let from = 0;
      for (
        let end = bytes.indexOf(10);
        end !== -1;
        end = bytes.indexOf(10, from)
      ) {
        parts.push(bytes.subarray(from, end));
        length += end - from;
        const found = consume(true);
        if (found) return found;
        from = end + 1;
      }
      if (from < bytes.length) {
        parts.push(bytes.subarray(from));
        length += bytes.length - from;
      }
    }
    return (length ? consume(false) : undefined) ?? previous ?? fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
