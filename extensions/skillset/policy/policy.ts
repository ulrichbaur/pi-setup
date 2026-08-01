/**
 * Keeps skills available for manual use while limiting which ones the model
 * can see and invoke automatically.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLoadedSkills } from "../core.ts";
import { type SkillMenuItem, showSkillPolicyMenu } from "./policy-menu.ts";

export type SkillPolicyConfig = {
  /** Skills the model may see in <available_skills> and auto-invoke. */
  allowAutoInvocation?: string[];
};

const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "skill-policy.json");

/** Validates untrusted persisted data and creates an invocation policy. */
export function parseSkillPolicyConfig(
  value: unknown,
  source = "skill policy",
): Set<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source}: config must be an object`);
  }

  const config = value as SkillPolicyConfig;
  if (
    config.allowAutoInvocation !== undefined &&
    (!Array.isArray(config.allowAutoInvocation) ||
      config.allowAutoInvocation.some((name) => typeof name !== "string"))
  ) {
    throw new Error(
      `${source}: allowAutoInvocation must be an array of skill names`,
    );
  }

  return new Set(config.allowAutoInvocation ?? []);
}

// Loads and validates the persisted allowlist.
async function loadPolicy(): Promise<Set<string>> {
  if (!existsSync(CONFIG_PATH)) return new Set<string>();

  const raw = await readFile(CONFIG_PATH, "utf8");
  return parseSkillPolicyConfig(JSON.parse(raw), CONFIG_PATH);
}

// Persists a stable, sorted allowlist atomically with user-only permissions.
async function savePolicy(policy: ReadonlySet<string>): Promise<void> {
  const config: SkillPolicyConfig = {
    allowAutoInvocation: [...policy].sort(),
  };
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, CONFIG_PATH);
}

const AVAILABLE_SKILLS_BLOCK =
  /\n?<available_skills>[\s\S]*?<\/available_skills>\n?/g;

/**
 * Detects the markup this policy relies on. When Pi reports loaded skills but
 * the prompt has no recognizable block, filtering would silently do nothing.
 */
export function hasAvailableSkillsBlock(systemPrompt: string): boolean {
  return new RegExp(AVAILABLE_SKILLS_BLOCK.source).test(systemPrompt);
}

// Hiding skills here prevents auto-invocation without disabling manual /skill:name commands.
export function filterAvailableSkills(
  systemPrompt: string,
  policy: ReadonlySet<string>,
): string {
  return systemPrompt.replace(AVAILABLE_SKILLS_BLOCK, (block) => {
    const kept = [...block.matchAll(/<skill>[\s\S]*?<\/skill>/g)]
      .map((match) => match[0])
      .filter((skillXml) => {
        const name = skillXml.match(/<name>(.*?)<\/name>/)?.[1]?.trim();
        return name ? policy.has(name) : false;
      });

    if (kept.length === 0) return "\n";
    return `\n<available_skills>\n${kept.join("\n")}\n</available_skills>\n`;
  });
}

// Registers policy commands and model-facing prompt filtering.
export default function skillPolicy(pi: ExtensionAPI) {
  pi.registerCommand("skill-policy", {
    description: "Edit skill auto-invocation policy",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The skill policy editor requires TUI mode", "error");
        return;
      }

      try {
        const policy = await loadPolicy();
        const loadedSkills = getLoadedSkills(ctx);
        const loaded = new Set(loadedSkills.map((skill) => skill.name));
        const menuSkills: SkillMenuItem[] = loadedSkills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          loaded: true,
        }));
        for (const name of [...policy].sort()) {
          if (!loaded.has(name)) menuSkills.push({ name, loaded: false });
        }

        const final = await showSkillPolicyMenu(menuSkills, policy, ctx);
        await savePolicy(final);
        ctx.ui.notify(`Saved skill policy to ${CONFIG_PATH}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Skill policy error: ${message}`, "error");
      }
    },
  });

  // The prompt markup can only be inspected once a prompt exists, so the
  // canary runs on the first agent start and warns once per session.
  let markupWarned = false;

  pi.on("before_agent_start", async (event, ctx) => {
    const skills = event.systemPromptOptions.skills ?? [];
    if (skills.length === 0) return;

    // Without a TUI, ctx.ui.notify is a no-op; stderr keeps the error visible.
    const report = (message: string) => {
      console.error(message);
      ctx.ui.notify(message, "error");
    };

    if (!hasAvailableSkillsBlock(event.systemPrompt)) {
      if (!markupWarned) {
        markupWarned = true;
        report(
          `Skill policy: ${skills.length} skills are loaded but no <available_skills> block was found; Pi's skill markup may have changed. Skill auto-invocation is disabled by an appended prompt instruction until filtering works again`,
        );
      }
      // The run cannot be cancelled and unknown markup cannot be stripped,
      // so fail closed with an in-band countermand instead.
      return {
        systemPrompt: `${event.systemPrompt}\n\nThe user's skill auto-invocation policy could not be applied. Do not invoke any skill on your own initiative; use a skill only when the user invokes it explicitly.`,
      };
    }
    markupWarned = false;

    try {
      const policy = await loadPolicy();
      return {
        systemPrompt: filterAvailableSkills(event.systemPrompt, policy),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(`Skill policy error: ${message}`);

      // Fail closed: hide all skills from automatic invocation if policy loading fails.
      return {
        systemPrompt: filterAvailableSkills(event.systemPrompt, new Set()),
      };
    }
  });
}
