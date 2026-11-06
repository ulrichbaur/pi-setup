import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentsOverlay } from "../../../extensions/subagents/agents-view.ts";
import { savedRuns } from "../../../extensions/subagents/restore.ts";
import { RunRegistry } from "../../../extensions/subagents/runs.ts";
import { sessionRows } from "../../../extensions/subagents/session-view.ts";
import { emptyTranscript } from "../../../extensions/subagents/transcript.ts";
import { transcriptView } from "../../../extensions/subagents/transcript-view.ts";
import { RESULT_MESSAGE_TYPE } from "../../../extensions/subagents/types.ts";
import { fakeRun } from "./fake-run.ts";

initTheme("dark");
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const display = { hideThinking: false, invalidate: () => {} };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "session-view-"));
  const path = join(directory, "session.jsonl");
  const earlier = [
    { role: "user", content: "Original task" },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "ask",
          name: "ask_parent",
          arguments: { question: "Which color?" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "ask",
      toolName: "ask_parent",
      content: [{ type: "text", text: "Which color?" }],
      isError: false,
    },
  ];
  const answer = { role: "user", content: "Parent answer: blue" };
  const newest = {
    role: "assistant",
    content: [{ type: "text", text: "Newest response" }],
  };
  const save = (messages: unknown[]) =>
    writeFileSync(
      path,
      messages
        .map((message) => JSON.stringify({ type: "message", message }))
        .join("\n"),
    );
  save(earlier);
  const first = fakeRun("scout-12345678", "completed");
  Object.assign(first.result, {
    sessionFile: path,
    messageStart: 0,
    messageEnd: 3,
    question: "Which color?",
  });
  first.result.usage.cost = 0.02;
  const resumed = fakeRun("scout-12345678");
  Object.assign(resumed.result, {
    sessionFile: path,
    messageStart: 3,
    live: emptyTranscript(),
  });
  resumed.result.usage.cost = 0.03;
  return { directory, path, earlier, answer, newest, save, first, resumed };
}

function continuous(text: string) {
  assert.match(text, /Original task/);
  assert.match(text, /Which color\?/);
  assert.match(text, /Parent answer: blue/);
  assert.match(text, /Newest response/);
  assert.ok(text.indexOf("Original task") < text.indexOf("Which color?"));
  assert.ok(text.indexOf("Which color?") < text.indexOf("Parent answer: blue"));
  assert.ok(
    text.indexOf("Parent answer: blue") < text.indexOf("Newest response"),
  );
}

test("ask_parent continuation stays one row with continuous history while streaming, finished, and restored", () => {
  const f = fixture();
  try {
    const registry = new RunRegistry();
    registry.add(f.first);
    const overlay = new AgentsOverlay(
      { terminal: { rows: 100 }, requestRender() {} } as unknown as TUI,
      theme,
      registry,
      () => {},
      { hideThinking: () => false },
    );
    const screen = () => overlay.render(120).join("\n");
    screen();
    overlay.handleInput("\r");
    registry.add(f.resumed);
    f.resumed.result.live!.messages.push(f.answer);
    f.resumed.result.live!.streaming = f.newest;
    // The file may already include live messages. Only the prefix joins RPC output.
    f.save([...f.earlier, f.answer, f.newest]);
    continuous(screen());
    assert.equal(screen().match(/Newest response/g)?.length, 1);
    overlay.handleInput("\x18");
    assert.equal(f.resumed.stop.signal.aborted, true);
    assert.equal(f.first.stop.signal.aborted, false);
    f.resumed.result.live = undefined;
    f.resumed.result.messageEnd = 5;
    f.resumed.result.progress.status = "completed";
    continuous(screen());
    overlay.handleInput("\x1b");
    assert.match(screen(), /Subagents \(1\)/);
    assert.match(screen(), /\$0\.050/);
    assert.doesNotMatch(screen(), /asks the parent/);
    assert.equal(registry.list().length, 2);
    const entries = [f.first, f.resumed].map((run) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        details: { results: [run.result] },
      },
    }));
    const restored = sessionRows(
      savedRuns(entries, RESULT_MESSAGE_TYPE).reverse(),
    );
    assert.equal(restored.length, 1);
    assert.equal(restored[0].result.usage.cost, 0.05);
    continuous(
      transcriptView(restored[0].result, display, true)!.render(120).join("\n"),
    );
    const perRun = transcriptView(f.resumed.result, display)!
      .render(120)
      .join("\n");
    assert.doesNotMatch(perRun, /Original task|Which color/);
    assert.match(perRun, /Newest response/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("session rows deduplicate saved results and keep legacy results separate", () => {
  const a = fakeRun("scout-12345678", "completed");
  a.result.usage.cost = 0.02;
  const duplicate = { ...a, result: { ...a.result } };
  const legacy = fakeRun("legacy", "completed");
  legacy.result.sessionId = undefined;
  const rows = sessionRows([
    a,
    duplicate,
    legacy,
    { ...legacy, stop: new AbortController() },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].result.usage.cost, 0.02);
  assert.equal(a.result.usage.cost, 0.02);
});

test("unreadable and oversized history shows a visible warning", () => {
  const f = fixture();
  try {
    const registry = new RunRegistry();
    registry.add(f.first);
    registry.add(f.resumed);
    const overlay = new AgentsOverlay(
      { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      theme,
      registry,
      () => {},
      { hideThinking: () => false },
    );
    overlay.handleInput("\r");
    writeFileSync(f.path, " ".repeat(10 * 1024 * 1024 + 1));
    assert.match(
      overlay.render(200).join("\n"),
      /Transcript unavailable: .*exceeds 10 MiB/,
    );
    rmSync(f.path);
    assert.match(
      overlay.render(200).join("\n"),
      /Transcript unavailable: .*session file no longer exists/,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
