import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const IMAGE_TOKEN_ESTIMATE = 1_600;
const TOOL_COLORS: ThemeColor[] = [
  "syntaxFunction",
  "error",
  "toolDiffAdded",
  "toolDiffRemoved",
  "syntaxType",
  "syntaxKeyword",
  "mdLink",
  "mdCode",
  "syntaxString",
  "syntaxNumber",
  "mdQuote",
  "borderAccent",
];

export interface ContextCategory {
  key: string;
  label: string;
  tokens: number;
  color: ThemeColor;
}

export interface ContextBreakdown {
  categories: ContextCategory[];
  totalTokens: number;
  contextWindow: number;
  percent: number | null;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  messageCount: number;
  turnCount: number;
}

function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateContentTokens(
  content: string | Array<{ type: string; text?: string }>,
): number {
  if (typeof content === "string") return estimateStringTokens(content);
  return content.reduce((total, block) => {
    if (block.type === "text") {
      return total + estimateStringTokens(block.text ?? "");
    }
    if (block.type === "image") return total + IMAGE_TOKEN_ESTIMATE;
    return total;
  }, 0);
}

function addCategory(
  categories: ContextCategory[],
  key: string,
  label: string,
  tokens: number,
  color: ThemeColor,
): void {
  if (tokens > 0) categories.push({ key, label, tokens, color });
}

function normalizeCategories(
  categories: ContextCategory[],
  targetTokens: number,
): ContextCategory[] {
  const estimated = categories.reduce(
    (total, category) => total + category.tokens,
    0,
  );
  if (targetTokens <= 0) return [];
  if (estimated <= 0) {
    return [
      {
        key: "other",
        label: "Other / overhead",
        tokens: targetTokens,
        color: "muted",
      },
    ];
  }

  const normalized = categories.map((category) => ({
    ...category,
    tokens: Math.max(
      1,
      Math.round((category.tokens / estimated) * targetTokens),
    ),
  }));
  const normalizedTotal = normalized.reduce(
    (total, category) => total + category.tokens,
    0,
  );
  const largest = normalized.reduce((best, category) =>
    category.tokens > best.tokens ? category : best,
  );
  largest.tokens = Math.max(1, largest.tokens + targetTokens - normalizedTotal);
  return normalized;
}

/** Estimate how the active model context is distributed across message types. */
export function computeContextBreakdown(
  ctx: ExtensionCommandContext,
): ContextBreakdown | null {
  const usage: ContextUsage | undefined = ctx.getContextUsage();
  if (!usage) return null;

  const contextEntries = ctx.sessionManager.buildContextEntries();
  const branch = ctx.sessionManager.getBranch();
  const toolTokens = new Map<string, number>();
  let systemTokens = 0;
  let userTokens = 0;
  let assistantTokens = 0;
  let thinkingTokens = 0;
  let compactionTokens = 0;
  let customTokens = 0;
  let imageTokens = 0;

  try {
    systemTokens = estimateStringTokens(ctx.getSystemPrompt());
  } catch {
    systemTokens = 0;
  }

  for (const entry of contextEntries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "user") {
        const user = message as UserMessage;
        if (typeof user.content === "string") {
          userTokens += estimateStringTokens(user.content);
        } else {
          for (const block of user.content) {
            if (block.type === "text") {
              userTokens += estimateStringTokens(block.text);
            } else if (block.type === "image") {
              imageTokens += IMAGE_TOKEN_ESTIMATE;
            }
          }
        }
      } else if (message.role === "assistant") {
        const assistant = message as AssistantMessage;
        for (const block of assistant.content) {
          if (block.type === "text") {
            assistantTokens += estimateStringTokens(block.text);
          } else if (block.type === "thinking") {
            thinkingTokens += estimateStringTokens(block.thinking);
          } else if (block.type === "toolCall") {
            assistantTokens += estimateStringTokens(
              JSON.stringify(block.arguments),
            );
          }
        }
      } else if (message.role === "toolResult") {
        const result = message as ToolResultMessage;
        const tokens = estimateContentTokens(result.content);
        toolTokens.set(
          result.toolName,
          (toolTokens.get(result.toolName) ?? 0) + tokens,
        );
      }
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      compactionTokens += estimateStringTokens(entry.summary);
    } else if (entry.type === "custom_message") {
      customTokens += estimateContentTokens(entry.content);
    }
  }

  let cacheRead = 0;
  let cacheWrite = 0;
  let totalCost = 0;
  let messageCount = 0;
  let turnCount = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    messageCount += 1;
    if (entry.message.role !== "assistant") continue;
    turnCount += 1;
    const assistant = entry.message as AssistantMessage;
    cacheRead += assistant.usage?.cacheRead ?? 0;
    cacheWrite += assistant.usage?.cacheWrite ?? 0;
    totalCost += assistant.usage?.cost?.total ?? 0;
  }

  const estimatedCategories: ContextCategory[] = [];
  addCategory(
    estimatedCategories,
    "system",
    "System prompt",
    systemTokens,
    "mdHeading",
  );
  addCategory(
    estimatedCategories,
    "user",
    "User messages",
    userTokens,
    "accent",
  );
  addCategory(
    estimatedCategories,
    "assistant",
    "Assistant text",
    assistantTokens,
    "success",
  );
  addCategory(
    estimatedCategories,
    "thinking",
    "Thinking",
    thinkingTokens,
    "warning",
  );

  const sortedTools = [...toolTokens.entries()].sort(
    (left, right) => right[1] - left[1],
  );
  sortedTools.forEach(([name, tokens], index) => {
    addCategory(
      estimatedCategories,
      `tool:${name}`,
      `Tool: ${name}`,
      tokens,
      TOOL_COLORS[index % TOOL_COLORS.length] ?? "toolTitle",
    );
  });

  addCategory(
    estimatedCategories,
    "compaction",
    "Compaction",
    compactionTokens,
    "muted",
  );
  addCategory(
    estimatedCategories,
    "custom",
    "Custom messages",
    customTokens,
    "customMessageLabel",
  );
  addCategory(estimatedCategories, "images", "Images", imageTokens, "mdLink");

  const estimatedTotal = estimatedCategories.reduce(
    (total, category) => total + category.tokens,
    0,
  );
  const totalTokens = usage.tokens ?? estimatedTotal;
  const usedTokens = Math.max(0, Math.min(totalTokens, usage.contextWindow));
  const categories = normalizeCategories(estimatedCategories, usedTokens);
  categories.push({
    key: "free",
    label: "Free",
    tokens: Math.max(0, usage.contextWindow - usedTokens),
    color: "dim",
  });

  return {
    categories,
    totalTokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
    cacheRead,
    cacheWrite,
    totalCost,
    messageCount,
    turnCount,
  };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function contextCell(category: ContextCategory, theme: Theme): string {
  if (category.key === "free") return theme.fg("dim", "░░");
  return theme.fg(category.color, "██");
}

function renderGrid(
  breakdown: ContextBreakdown,
  width: number,
  theme: Theme,
): string[] {
  const columns = Math.max(1, Math.floor(width / 2));
  const rows = Math.min(10, Math.max(6, Math.floor(width / 10)));
  const cellCount = columns * rows;
  const tokenTotal = Math.max(1, breakdown.contextWindow);
  const cells: string[] = [];
  let remainingCells = cellCount;
  let remainingTokens = tokenTotal;

  for (let index = 0; index < breakdown.categories.length; index += 1) {
    const category = breakdown.categories[index];
    const isLast = index === breakdown.categories.length - 1;
    const count = isLast
      ? remainingCells
      : Math.min(
          remainingCells,
          Math.max(
            category.tokens > 0 ? 1 : 0,
            Math.round((category.tokens / remainingTokens) * remainingCells),
          ),
        );
    for (let cell = 0; cell < count; cell += 1) {
      cells.push(contextCell(category, theme));
    }
    remainingCells -= count;
    remainingTokens = Math.max(1, remainingTokens - category.tokens);
  }

  const free = breakdown.categories.find((category) => category.key === "free");
  while (cells.length < cellCount) {
    cells.push(contextCell(free ?? breakdown.categories[0], theme));
  }

  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    lines.push(cells.slice(row * columns, (row + 1) * columns).join(""));
  }
  return lines;
}

function padVisible(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** Render the context breakdown as a bounded overlay. */
export function renderContextOverlay(
  breakdown: ContextBreakdown,
  theme: Theme,
  width: number,
): string[] {
  if (width < 4) return [truncateToWidth("Context", width, "")];
  const innerWidth = width - 2;
  const lines: string[] = [];
  const border = (text: string) => theme.fg("border", text);
  const row = (content = "") =>
    `${border("│")}${padVisible(` ${content}`, innerWidth)}${border("│")}`;
  const rule = () =>
    `${border("│")}${border("─".repeat(innerWidth))}${border("│")}`;

  lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
  const percent =
    breakdown.percent === null ? "" : ` (${breakdown.percent.toFixed(1)}%)`;
  lines.push(
    row(theme.bold(theme.fg("accent", `Context Window Usage${percent}`))),
  );
  lines.push(
    row(
      theme.fg(
        "muted",
        `${formatTokens(breakdown.totalTokens)} / ${formatTokens(breakdown.contextWindow)} tokens`,
      ),
    ),
  );
  lines.push(row(theme.fg("dim", "Estimated category breakdown")));
  lines.push(row());

  for (const gridLine of renderGrid(breakdown, innerWidth, theme)) {
    const centered = `${" ".repeat(Math.max(0, Math.floor((innerWidth - visibleWidth(gridLine)) / 2)))}${gridLine}`;
    lines.push(
      `${border("│")}${padVisible(centered, innerWidth)}${border("│")}`,
    );
  }

  lines.push(row());
  lines.push(rule());
  lines.push(row());

  const legend = breakdown.categories.filter((category) => category.tokens > 0);
  const twoColumns = innerWidth >= 72;
  const columnWidth = twoColumns
    ? Math.floor((innerWidth - 3) / 2)
    : innerWidth - 1;
  const legendEntry = (category: ContextCategory): string => {
    const percentage = (
      (category.tokens / breakdown.contextWindow) *
      100
    ).toFixed(1);
    const text = `${contextCell(category, theme)} ${theme.fg(category.color, category.label)} ${theme.fg("dim", `${formatTokens(category.tokens)} (${percentage}%)`)}`;
    return padVisible(text, columnWidth);
  };

  for (let index = 0; index < legend.length; index += twoColumns ? 2 : 1) {
    const left = legendEntry(legend[index]);
    const right =
      twoColumns && legend[index + 1] ? legendEntry(legend[index + 1]) : "";
    lines.push(row(`${left}${twoColumns ? `  ${right}` : ""}`));
  }

  lines.push(row());
  lines.push(rule());
  lines.push(row());
  lines.push(row(theme.bold(theme.fg("accent", "Session Stats"))));

  const stats = [
    `Turns: ${breakdown.turnCount}`,
    `Messages: ${breakdown.messageCount}`,
    `Cache read: ${formatTokens(breakdown.cacheRead)}`,
    `Cache write: ${formatTokens(breakdown.cacheWrite)}`,
    `Cost: $${breakdown.totalCost.toFixed(4)}`,
  ];
  let current = "";
  for (const stat of stats) {
    const next = current ? `${current}  │  ${stat}` : stat;
    if (current && visibleWidth(next) > innerWidth - 2) {
      lines.push(row(theme.fg("muted", current)));
      current = stat;
    } else {
      current = next;
    }
  }
  if (current) lines.push(row(theme.fg("muted", current)));

  const suggestions: string[] = [];
  if (breakdown.percent !== null && breakdown.percent > 80) {
    suggestions.push("Context usage is above 80%. Consider /compact.");
  }
  if (breakdown.percent !== null && breakdown.percent > 95) {
    suggestions.push(
      "Context is near its limit. Compaction is strongly recommended.",
    );
  }
  const biggestTool = breakdown.categories
    .filter((category) => category.key.startsWith("tool:"))
    .sort((left, right) => right.tokens - left.tokens)[0];
  if (biggestTool && biggestTool.tokens > breakdown.contextWindow * 0.2) {
    const percentage = (
      (biggestTool.tokens / breakdown.contextWindow) *
      100
    ).toFixed(0);
    suggestions.push(
      `${biggestTool.label} uses ${percentage}% of context. Consider summarizing large outputs.`,
    );
  }

  if (suggestions.length > 0) {
    lines.push(row());
    lines.push(rule());
    lines.push(row());
    for (const suggestion of suggestions) {
      lines.push(row(theme.fg("warning", suggestion)));
    }
  }

  lines.push(row());
  lines.push(row(theme.fg("dim", "Press Escape, q, or Enter to close")));
  lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
  return lines.map((line) => truncateToWidth(line, width, ""));
}

export default function contextExtension(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Visualize current context usage",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The context overlay requires TUI mode", "warning");
        return;
      }

      const breakdown = computeContextBreakdown(ctx);
      if (!breakdown) {
        ctx.ui.notify(
          "No context usage is available yet. Send a message first.",
          "warning",
        );
        return;
      }

      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => ({
          handleInput(data: string) {
            if (
              matchesKey(data, Key.escape) ||
              matchesKey(data, Key.enter) ||
              matchesKey(data, Key.ctrl("c")) ||
              data === "q"
            ) {
              done(undefined);
            }
          },
          render(width: number) {
            return renderContextOverlay(breakdown, theme, width);
          },
          invalidate() {},
        }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "80%",
            minWidth: 48,
            maxHeight: "90%",
          },
        },
      );
    },
  });
}
