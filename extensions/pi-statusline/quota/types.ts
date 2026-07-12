/** Defines the provider-neutral quota contract used by fetchers, caching, and rendering. */

export type QuotaProvider = "codex" | "opencode-go";

export type QuotaWindow = {
  label: string;
  percentRemaining: number;
  /** Decimal places for display. Derived from the raw API value precision. */
  precision?: number;
  resetsAt?: Date;
};

export type QuotaStatus = {
  provider: QuotaProvider;
  windows: QuotaWindow[];
  fetchedAt: Date;
  /** Set by the cache wrapper after repeated refresh failures. */
  stale?: boolean;
  /** Shown in-place when windows is empty, e.g. missing credentials. */
  error?: string;
};

export type QuotaAdapterContext = {
  signal?: AbortSignal;
  modelRegistry?: {
    getApiKeyForProvider(provider: string): Promise<string | undefined>;
  };
};

export type QuotaAdapter = {
  provider: QuotaProvider;
  getQuota(ctx: QuotaAdapterContext): Promise<QuotaStatus | undefined>;
};
