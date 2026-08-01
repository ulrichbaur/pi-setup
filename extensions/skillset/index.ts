import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillPalette from "./palette/palette.ts";
import skillPolicy from "./policy/policy.ts";
import skillUsage from "./usage/usage.ts";

type SkillsetFeature = {
  name: string;
  register(pi: ExtensionAPI): void;
};

const FEATURES: readonly SkillsetFeature[] = [
  { name: "palette", register: skillPalette },
  { name: "policy", register: skillPolicy },
  { name: "usage", register: skillUsage },
];

/** Registers features independently and returns visible startup diagnostics. */
export function registerSkillsetFeatures(
  pi: ExtensionAPI,
  features: readonly SkillsetFeature[],
  report: (message: string) => void = console.error,
): string[] {
  const errors: string[] = [];
  for (const feature of features) {
    try {
      feature.register(pi);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Skillset ${feature.name} registration failed: ${detail}`;
      errors.push(message);
      report(message);
    }
  }
  return errors;
}

/** Registers each skillset concern without letting one disable the others. */
export default function skillset(pi: ExtensionAPI): void {
  const errors = registerSkillsetFeatures(pi, FEATURES);
  if (errors.length === 0) return;

  pi.on("session_start", async (_event, ctx) => {
    for (const message of errors) ctx.ui.notify(message, "error");
  });
}
