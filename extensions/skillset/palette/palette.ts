import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLoadedSkills } from "../core.ts";
import { showSkillPalette } from "./palette-menu.ts";

export default function skillPalette(pi: ExtensionAPI): void {
  pi.registerCommand("skill", {
    description: "Select a loaded skill command",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The skill palette requires TUI mode", "error");
        return;
      }
      const skills = getLoadedSkills(ctx);
      if (skills.length === 0) {
        ctx.ui.notify("No skills are loaded", "warning");
        return;
      }
      const selected = await showSkillPalette(skills, ctx);
      if (selected) ctx.ui.setEditorText(`/skill:${selected.name} `);
    },
  });
}
