import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { extractSkillUsageEvents } from "../../../../extensions/skillset/history/extract.ts";

const wrapper =
  '<skill name="deleted-name" location="/deleted/SKILL.md">\nReferences are relative to /deleted.\n\n  # Historical ü\n\n</skill>\n\nprivate request';
function extract(text: string, role = "user") {
  return extractSkillUsageEvents({
    entries: [
      {
        type: "message",
        id: "entry",
        timestamp: "2026-01-01T00:00:00Z",
        message: { role, content: text },
      },
    ],
    project: "/project",
    sessionId: "session",
  });
}

test("hashes only the historical trimmed UTF-8 body and preserves recorded identity", () => {
  const [event] = extract(wrapper);
  assert.deepEqual(event, {
    timestamp: "2026-01-01T00:00:00.000Z",
    kind: "explicit",
    skill: {
      name: "deleted-name",
      path: "/deleted/SKILL.md",
      bodyHash: `sha256:${createHash("sha256").update("# Historical ü").digest("hex")}`,
    },
    project: "/project",
    sessionId: "session",
    entryId: "entry",
  });
  assert.doesNotMatch(
    JSON.stringify(event),
    /Historical|private request|References/,
  );
});

test("rejects embedded XML, quoted examples, malformed wrappers and non-user messages", () => {
  for (const text of [
    `Example:\n${wrapper}`,
    `\`\`\`\n${wrapper}\n\`\`\``,
    wrapper.replace('location="', 'other="'),
    wrapper.replace("\n\n</skill>", "</skill>"),
  ])
    assert.deepEqual(extract(text), []);
  assert.deepEqual(extract(wrapper, "assistant"), []);
  assert.deepEqual(extract(wrapper, "toolResult"), []);
});

test("recognized legacy wrapper without identifiable body has a null hash", () => {
  assert.equal(
    extract('<skill name="old" location="/missing">\nbody\n</skill>')[0]?.skill
      .bodyHash,
    null,
  );
  assert.deepEqual(
    extract('<skill name="old" location="/missing">body</skill>'),
    [],
  );
});

test("handles a native text block with images but not prose in another text block", () => {
  const run = (content: unknown) =>
    extractSkillUsageEvents({
      entries: [
        {
          type: "message",
          timestamp: "2026-01-01",
          message: { role: "user", content },
        },
      ],
      project: "",
      sessionId: null,
    });
  assert.equal(
    run([{ type: "text", text: wrapper }, { type: "image" }]).length,
    1,
  );
  assert.equal(
    run([
      { type: "text", text: "example" },
      { type: "text", text: wrapper },
    ]).length,
    0,
  );
});
