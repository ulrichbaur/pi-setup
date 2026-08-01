import type {
  ExtensionCommandContext,
  Skill,
} from "@earendil-works/pi-coding-agent";

/** Returns Pi's effective post-discovery skill collection in stable name order. */
export function getLoadedSkills(ctx: ExtensionCommandContext): Skill[] {
  return [...(ctx.getSystemPromptOptions().skills ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
