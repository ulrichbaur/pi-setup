import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillPalette from "./palette/palette.ts";
import skillPolicy from "./policy/policy.ts";

/** Registers user selection and model auto-invocation policy as one extension. */
export default function skillset(pi: ExtensionAPI): void {
  skillPalette(pi);
  skillPolicy(pi);
}
