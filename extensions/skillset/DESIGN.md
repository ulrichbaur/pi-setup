# Skillset Extension

Features register independently.
A registration failure remains visible and does not disable other features.

## Palette (`/skill`)

The TUI picker searches Pi's loaded skill names and descriptions.
Skills appear in alphabetical order.
Selection fills the editor with `/skill:name ` for Pi's native expansion.
The picker never reads usage history.

## Policy (`/skill-policy`)

The existing empty-default allowlist controls automatic model invocation.
Policy hides skills from the model, never from explicit user invocation.
A broken policy fails closed and reports the error.

## Export (`/usage`)

This command takes no arguments.
It scans saved `.jsonl` session files recursively under `<getAgentDir()>/sessions/` only on invocation.
It does not migrate or rewrite sessions.
There are no background scans, caches, usage rankings, dashboards, or trends.

Each invocation writes `<getAgentDir()>/skill-usage/<filesystem-safe-ISO-timestamp>-<UUID>.json` with exclusive creation and user-only file permissions.
`getAgentDir()` respects `PI_CODING_AGENT_DIR`.
Reports are immutable from this extension's perspective.
There is no managed history, cleanup, or latest pointer.
The command shows the full path and counts after writing.
Write failures show the destination path.

The schema is:

```typescript
{
  schemaVersion: 1,
  generatedAt: string, // ISO timestamp
  scan: {
    sessionsAnalyzed: number,
    errors: Array<{ sessionFile: string, message: string }>
  },
  summary: { explicitInvocations: number },
  events: Array<{
    timestamp: string, // ISO timestamp
    kind: 'explicit',
    skill: { name: string, path: string, bodyHash: string | null },
    project: string,
    sessionId: string | null,
    entryId: string | null
  }>
}
```

`sessionsAnalyzed` counts files that parse and extract successfully, including empty sessions and fork copies.
Failed files do not contribute events or count as analyzed.
Malformed JSON, including a partial final line, appears in `scan.errors`.
Directory read failures also appear there with the directory path.
A missing sessions directory means an empty scan.
Other files continue after an error.

Only saved user messages with Pi's complete native expansion wrapper qualify.
The wrapper must start at the beginning of the text and use Pi's attribute order, newlines, closing tag, and optional double-newline request suffix.
A content array must contain one leading text block and only images afterward.
Embedded examples, tool reads of `SKILL.md`, assistant text, and automatic use do not qualify.
Names and paths remain as recorded, including renamed or deleted skills.
No loaded-skill filtering or live skill file reads occur.

For current expansions, `bodyHash` is `sha256:` followed by the lowercase hexadecimal SHA-256 digest of UTF-8 `body.trim()`.
The body excludes the generated `References are relative to <baseDir>.` header, its blank separator, the wrapper, and the optional user request.
Pi already strips frontmatter and trims the body before expansion.
A recognizable older wrapper without an identifiable References header gets a null hash.
Unrecognized older formats are not counted.
A user who pastes the exact native wrapper is indistinguishable from a native invocation in saved logs.
This export is not an authenticated invocation audit.

Entry IDs survive native forks.
Within a parent-session lineage, matching entry ID, timestamp, and recorded skill metadata identify inherited copies.
The shallowest available session supplies the originating project and session ID.
If the original is missing, a deterministic available copy supplies them.
Unrelated lineages do not merge coincidentally equal short IDs.
Legacy entries without IDs keep a null entry ID and are not deduplicated across files.
Events sort chronologically, with deterministic metadata ordering for ties.
All saved branches count, including entries later compacted or omitted from model context.

Reports contain no message bodies, user requests, prompts, or tool output.
They still contain potentially sensitive project paths, skill paths, and session identifiers.
