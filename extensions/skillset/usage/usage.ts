import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { collectSkillUsage } from "../history/sessions.ts";
import type { SkillUsageReport } from "../history/types.ts";

/** Creates an exclusive report file without maintaining report history. */
export async function exportSkillUsage(
  agentDirectory = getAgentDir(),
  now = new Date(),
): Promise<{ path: string; report: SkillUsageReport }> {
  const directory = resolve(agentDirectory, "skill-usage");
  const path = join(
    directory,
    `${now.toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  try {
    const { events, sessionsAnalyzed, errors } = await collectSkillUsage(
      join(agentDirectory, "sessions"),
    );
    const report: SkillUsageReport = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      scan: { sessionsAnalyzed, errors },
      summary: { explicitInvocations: events.length },
      events,
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return { path, report };
  } catch (error) {
    throw new Error(
      `Could not export skill usage to ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export default function skillUsage(pi: ExtensionAPI): void {
  pi.registerCommand("usage", {
    description:
      "Export explicit skill invocations from saved sessions to JSON",
    handler: async (args, ctx) => {
      const show = (text: string, level: "info" | "warning" | "error") => {
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else console.error(text);
      };
      try {
        if (args.trim()) throw new Error("`/usage` has no arguments");
        const { path, report } = await exportSkillUsage();
        show(
          `Skill usage exported to ${path}\n${report.summary.explicitInvocations} explicit invocations; ${report.scan.sessionsAnalyzed} sessions analyzed; ${report.scan.errors.length} scan errors.`,
          report.scan.errors.length ? "warning" : "info",
        );
      } catch (error) {
        show(
          `Skill usage: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
