/** Builds the quota status the footer shows in place of windows. */

import type { QuotaProvider, QuotaStatus } from "./types.ts";

export function errorStatus(
  provider: QuotaProvider,
  error: string,
): QuotaStatus {
  return { provider, windows: [], fetchedAt: new Date(), error };
}
