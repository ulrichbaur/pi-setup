import {
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatCost } from "../../lib/subagent-cost.ts";
import { type TranscriptDisplay, transcriptView } from "./transcript-view.ts";
import type { AgentResult, SubagentDetails } from "./types.ts";

function formatTokens(value: number): string {
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(1)}k`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 60_000
    ? `${(milliseconds / 1_000).toFixed(1)}s`
    : `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

export type Theme = ExtensionContext["ui"]["theme"];

function renderAgent(
  result: AgentResult,
  expanded: boolean,
  theme: Theme,
  display: TranscriptDisplay,
): Container {
  const container = new Container();
  const icon =
    result.progress.status === "running"
      ? theme.fg("warning", "⟳")
      : result.progress.status === "pending"
        ? theme.fg("dim", "○")
        : result.progress.status === "completed"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
  const tokens = result.usage.input + result.usage.output;
  container.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${result.agentSource ? theme.fg("dim", ` [${result.agentSource}]`) : ""} ${theme.fg("dim", `${result.progress.toolCount} tools · ${formatTokens(tokens)} tok · ${formatDuration(result.progress.durationMs)}${result.usage.cost > 0 ? ` · ${formatCost(result.usage.cost)}` : ""}${result.sessionId ? ` · ${result.sessionId}` : ""}`)}`,
      0,
      0,
    ),
  );
  const task = expanded
    ? result.task
    : result.task.replace(/\s+/g, " ").slice(0, 160);

  if (expanded) {
    let transcript: Container | undefined;
    let unavailable: string | undefined;
    try {
      transcript = transcriptView(result, display);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
    // The transcript starts with the task, so it needs no task line.
    if (transcript) {
      container.addChild(transcript);
      addFooter(container, result, theme);
      return container;
    }
    if (unavailable) {
      container.addChild(
        new Text(
          theme.fg("warning", `Transcript unavailable: ${unavailable}`),
          0,
          0,
        ),
      );
    }
  }
  container.addChild(new Text(theme.fg("dim", `Task: ${task}`), 0, 0));

  const tools = expanded
    ? result.progress.recentTools
    : result.progress.recentTools.slice(-5);
  for (const tool of tools) {
    container.addChild(
      new Text(theme.fg("muted", `  ${tool.tool}: ${tool.args}`), 0, 0),
    );
  }
  if (result.progress.currentTool) {
    container.addChild(
      new Text(
        theme.fg(
          "warning",
          `▸ ${result.progress.currentTool}: ${result.progress.currentToolArgs ?? ""}`,
        ),
        0,
        0,
      ),
    );
  }
  if (expanded && result.output && result.progress.status !== "running") {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(result.output, 0, 0, getMarkdownTheme()));
  } else if (result.progress.lastMessage) {
    container.addChild(
      new Text(theme.fg("text", result.progress.lastMessage), 0, 0),
    );
  }
  addFooter(container, result, theme, expanded);
  return container;
}

function addFooter(
  container: Container,
  result: AgentResult,
  theme: Theme,
  showSession = true,
): void {
  if (result.progress.error) {
    container.addChild(
      new Text(theme.fg("error", `Error: ${result.progress.error}`), 0, 0),
    );
  }
  if (result.progress.warning) {
    container.addChild(
      new Text(
        theme.fg("warning", `Warning: ${result.progress.warning}`),
        0,
        0,
      ),
    );
  }
  if (showSession && result.sessionFile) {
    container.addChild(
      new Text(theme.fg("dim", `Session: ${result.sessionFile}`), 0, 0),
    );
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          `Work in it yourself: /agents open ${result.sessionId}`,
        ),
        0,
        0,
      ),
    );
  }
}

/** The text the parent model receives for one subagent run. */
export function resultText(result: AgentResult): string {
  let text = result.output || "(no output)";
  if (result.userMessages?.length) {
    const messages = result.userMessages.map((message) => `- ${message}`);
    text += `\n\nThe user sent the subagent these messages while it ran:\n${messages.join("\n")}`;
  }
  if (result.sessionFile) text += `\n\nSession: ${result.sessionId}`;
  return text;
}

/** The text the parent model receives for one tool call's runs. */
export function combinedText(details: SubagentDetails): string {
  if (details.mode === "single") return resultText(details.results[0]);
  return details.results
    .map(
      (result) =>
        `## ${result.agent}${result.progress.status === "failed" ? " (FAILED)" : ""}\n\n${resultText(result)}`,
    )
    .join("\n\n---\n\n");
}

export function backgroundText(results: AgentResult[], each: boolean): string {
  const ids = results.map((result) => result.sessionId).join(", ");
  const arrival = each
    ? "Each result arrives as its own message when its run ends"
    : `The result arrives as a message when ${results.length > 1 ? "all of them end" : "the run ends"}`;
  return `Started in the background: ${ids}. ${arrival}. Continue with other work; do not wait or poll for it. The user can follow it with /agents.`;
}

export function renderDetails(
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme,
  display: TranscriptDisplay,
): Container {
  const container = new Container();
  if (details.background) {
    for (const result of details.results) {
      container.addChild(
        new Text(
          `${theme.fg("accent", "⇢")} ${theme.fg("toolTitle", theme.bold(result.agent))} ${theme.fg("dim", `${result.sessionId ?? ""} started in the background`)}`,
          0,
          0,
        ),
      );
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            `Task: ${result.task.replace(/\s+/g, " ").slice(0, 160)}`,
          ),
          0,
          0,
        ),
      );
    }
    container.addChild(
      new Text(theme.fg("dim", "Follow it with /agents."), 0, 0),
    );
    return container;
  }
  if (details.mode === "parallel") {
    const done = details.results.filter(
      (item) => item.progress.status === "completed",
    ).length;
    container.addChild(
      new Text(
        theme.fg(
          "toolTitle",
          theme.bold(`parallel ${done}/${details.results.length}`),
        ),
        0,
        0,
      ),
    );
    container.addChild(new Spacer(1));
  }
  details.results.forEach((item, index) => {
    container.addChild(renderAgent(item, expanded, theme, display));
    if (index < details.results.length - 1) {
      container.addChild(new Spacer(1));
    }
  });
  return container;
}
