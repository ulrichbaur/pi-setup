import { readFile } from "node:fs/promises";
import {
  type ExtensionAPI,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { showSkillPalette } from "./menu.ts";

let queuedSkill: Skill | null = null;

/** Formats a loaded skill exactly like Pi's native /skill:name expansion. */
export async function buildSkillBlock(skill: Skill): Promise<string> {
  const content = await readFile(skill.filePath, "utf8");
  const body = stripFrontmatter(content).trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

function clearIndicators(ctx: {
  ui: {
    setStatus(name: string, value: string | undefined): void;
    setWidget(name: string, value: string[] | undefined): void;
  };
}): void {
  ctx.ui.setStatus("skill-palette", undefined);
  ctx.ui.setWidget("skill-palette", undefined);
}

export default function skillPalette(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("skill-palette", (message, options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const name = content.match(/<skill name="([^"]+)"/)?.[1] ?? "skill";
    const lines = content.split("\n");
    const visible = options.expanded ? lines : lines.slice(0, 10);
    const container = new Container();
    container.addChild(
      new Text(
        `${theme.fg("accent", "◆ ")}${theme.fg("customMessageLabel", theme.bold("Skill: "))}${theme.fg("accent", name)}`,
        1,
        0,
      ),
    );
    for (const line of visible) {
      container.addChild(new Text(theme.fg("dim", line), 1, 0));
    }
    if (!options.expanded && lines.length > visible.length) {
      container.addChild(
        new Text(
          theme.fg("muted", `… ${lines.length - visible.length} more lines`),
          1,
          0,
        ),
      );
    }
    return container;
  });

  pi.registerCommand("skill", {
    description: "Queue a loaded skill for the next message",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The skill palette requires TUI mode", "error");
        return;
      }

      // This is Pi's post-discovery skill collection. In particular, package
      // filters from settings.json have already been applied to this list.
      const skills = [...(ctx.getSystemPromptOptions().skills ?? [])].sort(
        (left, right) => left.name.localeCompare(right.name),
      );
      if (skills.length === 0) {
        ctx.ui.notify("No skills are loaded", "warning");
        return;
      }

      const selected = await showSkillPalette(skills, queuedSkill, ctx);
      if (selected === undefined) return;
      if (selected === null) {
        queuedSkill = null;
        clearIndicators(ctx);
        ctx.ui.notify("Skill unqueued", "info");
        return;
      }

      queuedSkill = selected;
      ctx.ui.setStatus("skill-palette", `skill: ${selected.name}`);
      ctx.ui.setWidget("skill-palette", [
        `Skill: ${selected.name} — queued for the next message`,
      ]);
      ctx.ui.notify(`Skill queued: ${selected.name}`, "info");
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const skill = queuedSkill;
    if (!skill) return;

    queuedSkill = null;
    clearIndicators(ctx);
    try {
      return {
        message: {
          customType: "skill-palette",
          content: await buildSkillBlock(skill),
          display: true,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not load skill ${skill.name}: ${message}`, "error");
    }
  });
}
