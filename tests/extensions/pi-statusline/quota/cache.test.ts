import assert from "node:assert/strict";
import { test } from "node:test";
import { withQuotaCache } from "../../../../extensions/pi-statusline/quota/cache.ts";
import type {
  QuotaAdapter,
  QuotaStatus,
} from "../../../../extensions/pi-statusline/quota/types.ts";

const quota = (overrides: Partial<QuotaStatus> = {}): QuotaStatus => ({
  provider: "codex",
  windows: [{ label: "5h", percentRemaining: 75, precision: 0 }],
  fetchedAt: new Date(),
  ...overrides,
});

test("quota cache reuses fresh values and deduplicates concurrent requests", async () => {
  let now = 1_000;
  let calls = 0;
  let release: ((status: QuotaStatus) => void) | undefined;
  const pending = new Promise<QuotaStatus>((resolve) => (release = resolve));
  const adapter: QuotaAdapter = {
    provider: "codex",
    getQuota: async () => {
      calls++;
      return pending;
    },
  };
  const cached = withQuotaCache(adapter, { now: () => now, ttlOkMs: 100 });

  const first = cached.getQuota({});
  const second = cached.getQuota({});
  assert.equal(calls, 1);
  assert.ok(release);
  release(quota());
  assert.equal(await first, await second);

  now = 1_050;
  await cached.getQuota({});
  assert.equal(calls, 1);
});

test("quota cache serves stale data after repeated failures and recovers", async () => {
  let now = 1;
  let fail = false;
  let calls = 0;
  const adapter: QuotaAdapter = {
    provider: "codex",
    async getQuota() {
      calls++;
      if (fail) throw new Error("offline");
      return quota();
    },
  };
  const cached = withQuotaCache(adapter, {
    now: () => now,
    ttlOkMs: 1,
    ttlRetryMs: 1,
    staleFailureLimit: 3,
  });

  await cached.getQuota({});
  fail = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    now += 2;
    const result = await cached.getQuota({});
    assert.equal(result?.stale, attempt === 3 ? true : undefined);
  }
  fail = false;
  now += 2;
  assert.equal((await cached.getQuota({}))?.stale, undefined);
  assert.equal(calls, 5);
});

test("quota cache reports a source that never answered", async () => {
  let now = 1;
  const throwing = withQuotaCache(
    {
      provider: "codex",
      async getQuota() {
        throw new Error("usage request failed (404)");
      },
    },
    { now: () => now, ttlOkMs: 1, ttlRetryMs: 1, staleFailureLimit: 3 },
  );
  assert.equal(await throwing.getQuota({}), undefined);
  now += 2;
  assert.equal(await throwing.getQuota({}), undefined);
  now += 2;
  assert.equal(
    (await throwing.getQuota({}))?.error,
    "codex: usage request failed (404)",
  );

  const silent = withQuotaCache(
    { provider: "opencode-go", getQuota: async () => undefined },
    { now: () => now, ttlOkMs: 1, ttlRetryMs: 1, staleFailureLimit: 1 },
  );
  assert.equal(
    (await silent.getQuota({}))?.error,
    "opencode-go: no usage returned",
  );
});

test("quota cache replaces a good reading with an error status at once", async () => {
  let now = 1;
  let rejected = false;
  const adapter: QuotaAdapter = {
    provider: "codex",
    getQuota: async () =>
      rejected
        ? quota({
            windows: [],
            error: "codex: login rejected, re-run pi login",
          })
        : quota(),
  };
  const cached = withQuotaCache(adapter, { now: () => now, ttlOkMs: 1 });

  assert.equal((await cached.getQuota({}))?.windows.length, 1);
  rejected = true;
  now = 2;
  const status = await cached.getQuota({});
  assert.equal(status?.error, "codex: login rejected, re-run pi login");
  assert.equal(status?.stale, undefined);
});

test("quota cache aborts a hung request so later refreshes can run", async () => {
  let now = 1;
  let calls = 0;
  const adapter: QuotaAdapter = {
    provider: "codex",
    getQuota: ({ signal }) => {
      calls++;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason)),
      );
    },
  };
  const cached = withQuotaCache(adapter, {
    now: () => now,
    ttlOkMs: 1,
    ttlRetryMs: 1,
    staleFailureLimit: 1,
    timeoutMs: 10,
  });

  const status = await cached.getQuota({});
  assert.match(status?.error ?? "", /^codex: .*timeout/i);
  now = 3;
  await cached.getQuota({});
  assert.equal(calls, 2);
});

test("quota cache forwards Pi's abort signal to the adapter", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const cached = withQuotaCache({
    provider: "codex",
    getQuota: async ({ signal }) => {
      received = signal;
      return quota();
    },
  });
  await cached.getQuota({ signal: controller.signal });
  assert.equal(received?.aborted, false);
  controller.abort();
  assert.equal(received?.aborted, true);
});
