export type SkillUsageEvent = {
  timestamp: string;
  kind: "explicit";
  skill: { name: string; path: string; bodyHash: string | null };
  project: string;
  sessionId: string | null;
  entryId: string | null;
};

export type SkillUsageCollection = {
  events: SkillUsageEvent[];
  sessionsAnalyzed: number;
  errors: Array<{ sessionFile: string; message: string }>;
};

export type SkillUsageReport = {
  schemaVersion: 1;
  generatedAt: string;
  scan: Pick<SkillUsageCollection, "sessionsAnalyzed" | "errors">;
  summary: { explicitInvocations: number };
  events: SkillUsageEvent[];
};
