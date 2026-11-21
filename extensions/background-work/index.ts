import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagents } from "./subagents/register.ts";
import { registerTasks } from "./tasks/register.ts";

/**
 * Registers one feature. A failure is reported when a session starts and
 * leaves the other features working.
 */
async function registerFeature(
  pi: ExtensionAPI,
  name: string,
  register: () => void | Promise<void>,
): Promise<void> {
  try {
    await register();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`${name} not loaded: ${message}`, "error");
    });
  }
}

/** Background shell tasks and subagents. */
export default async function backgroundWork(pi: ExtensionAPI): Promise<void> {
  await registerFeature(pi, "Background tasks", () => registerTasks(pi));
  await registerFeature(pi, "Subagents", () => registerSubagents(pi));
}
