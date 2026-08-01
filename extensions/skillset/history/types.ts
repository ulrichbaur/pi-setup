export type SkillUsageEvent = {
  skillName: string;
  project: string;
  timestamp: number;
  sourceId: string;
};

export type SkillUsageSummary = {
  skillName: string;
  invocations: number;
  /** Sum of per-event decay weights: 1 when fresh, halved every 30 days. */
  frecency: number;
};
