/**
 * Keeps skills available for manual use while limiting which ones the model
 * can see and invoke automatically.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SkillMenuItem, showSkillPolicyMenu } from "./menu.ts";

type SkillPolicyConfig = {
  /** Skills the model may see in <available_skills> and auto-invoke. */
  allowAutoInvocation?: string[];
};

type SkillPolicy = {
  allowAutoInvocation: Set<string>;
};

const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "skill-policy.json");

// Creates the fail-closed default policy.
function emptyPolicy(): SkillPolicy {
  return {
    allowAutoInvocation: new Set(),
  };
}

// Loads and validates the persisted allowlist.
async function loadPolicy(): Promise<SkillPolicy> {
  const policy = emptyPolicy();
  if (!existsSync(CONFIG_PATH)) return policy;

  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as SkillPolicyConfig;

  if (
    parsed.allowAutoInvocation &&
    !Array.isArray(parsed.allowAutoInvocation)
  ) {
    throw new Error(
      `${CONFIG_PATH}: allowAutoInvocation must be an array of skill names`,
    );
  }
  for (const name of parsed.allowAutoInvocation ?? []) {
    policy.allowAutoInvocation.add(name);
  }

  return policy;
}

// Persists a stable, sorted allowlist atomically with user-only permissions.
async function savePolicy(policy: SkillPolicy): Promise<void> {
  const config: SkillPolicyConfig = {
    allowAutoInvocation: [...policy.allowAutoInvocation].sort(),
  };
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, CONFIG_PATH);
}

// Hiding skills here prevents auto-invocation without disabling manual /skill:name commands.
function filterAvailableSkills(
  systemPrompt: string,
  policy: SkillPolicy,
): string {
  return systemPrompt.replace(
    /\n?<available_skills>[\s\S]*?<\/available_skills>\n?/g,
    (block) => {
      const kept = [...block.matchAll(/<skill>[\s\S]*?<\/skill>/g)]
        .map((match) => match[0])
        .filter((skillXml) => {
          const name = skillXml.match(/<name>(.*?)<\/name>/)?.[1]?.trim();
          return name ? policy.allowAutoInvocation.has(name) : false;
        });

      if (kept.length === 0) return "\n";
      return `\n<available_skills>\n${kept.join("\n")}\n</available_skills>\n`;
    },
  );
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
        const loadedSkills = [
          ...(ctx.getSystemPromptOptions().skills ?? []),
        ].sort((left, right) => left.name.localeCompare(right.name));
        const loaded = new Set(loadedSkills.map((skill) => skill.name));
        const menuSkills: SkillMenuItem[] = loadedSkills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          loaded: true,
        }));
        for (const name of [...policy.allowAutoInvocation].sort()) {
          if (!loaded.has(name)) menuSkills.push({ name, loaded: false });
        }

        const final = await showSkillPolicyMenu(
          menuSkills,
          policy.allowAutoInvocation,
          ctx,
        );
        if (!final) return;

        policy.allowAutoInvocation = final;
        await savePolicy(policy);
        ctx.ui.notify(`Saved skill policy to ${CONFIG_PATH}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Skill policy error: ${message}`, "error");
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const skills = event.systemPromptOptions.skills ?? [];
    if (skills.length === 0) return;

    try {
      const policy = await loadPolicy();
      return {
        systemPrompt: filterAvailableSkills(event.systemPrompt, policy),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Skill policy error: ${message}`, "error");

      // Fail closed: hide all skills from automatic invocation if policy loading fails.
      return {
        systemPrompt: filterAvailableSkills(event.systemPrompt, emptyPolicy()),
      };
    }
  });
}
