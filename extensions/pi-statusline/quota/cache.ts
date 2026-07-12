/** Adds retry-aware in-memory caching and concurrent-request deduplication to quota fetchers. */

import type {
  QuotaAdapter,
  QuotaAdapterContext,
  QuotaStatus,
} from "./types.ts";

// Retry failures sooner than successful responses, but avoid fetching on every UI event.
const TTL_OK_MS = 60_000;
const TTL_RETRY_MS = 15_000;
// Do not label a cached value stale until transient failures have had time to recover.
const STALE_FAILURE_LIMIT = 3;

type QuotaCacheOptions = {
  now?: () => number;
  ttlOkMs?: number;
  ttlRetryMs?: number;
  staleFailureLimit?: number;
};

/**
 * Wraps an adapter with an in-memory TTL cache and in-flight dedup, so
 * per-message status updates don't hit provider endpoints on every turn.
 * After STALE_FAILURE_LIMIT consecutive refresh failures the cached
 * status is served with `stale: true`.
 */
export function withQuotaCache(
  adapter: QuotaAdapter,
  options: QuotaCacheOptions = {},
): QuotaAdapter {
  const now = options.now ?? Date.now;
  const ttlOkMs = options.ttlOkMs ?? TTL_OK_MS;
  const ttlRetryMs = options.ttlRetryMs ?? TTL_RETRY_MS;
  const staleFailureLimit = options.staleFailureLimit ?? STALE_FAILURE_LIMIT;
  let cached: QuotaStatus | undefined;
  let lastAttemptAt = 0;
  let failures = 0;
  let inflight: Promise<QuotaStatus | undefined> | undefined;

  // Once repeated failures make the value unreliable, expose that state without hiding it.
  function onFailure(): QuotaStatus | undefined {
    failures++;
    if (cached && failures >= staleFailureLimit)
      cached = { ...cached, stale: true };
    return cached;
  }

  return {
    provider: adapter.provider,
    async getQuota(ctx: QuotaAdapterContext): Promise<QuotaStatus | undefined> {
      // Multiple events can request the same refresh; share its result and request cost.
      if (inflight) return inflight;
      const ttl = failures > 0 ? ttlRetryMs : ttlOkMs;
      if (now() - lastAttemptAt < ttl) return cached;

      lastAttemptAt = now();
      inflight = adapter
        .getQuota(ctx)
        .then((status) => {
          if (!status) return onFailure();
          failures = 0;
          cached = status;
          return cached;
        })
        .catch((error: unknown) => {
          const fallback = onFailure();
          if (fallback) return fallback;
          throw error;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
