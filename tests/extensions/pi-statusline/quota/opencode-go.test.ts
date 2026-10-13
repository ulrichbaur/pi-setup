import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenCodeGoQuotaAdapter,
  parseOpenCodeGoStatus,
} from "../../../../extensions/pi-statusline/quota/opencode-go.ts";

const SAMPLE_STATUS = {
  product: "go",
  access: {
    startsAt: "2026-10-04T05:55:52.000Z",
    endsAt: "2026-11-04T05:55:52.000Z",
    meters: {
      fiveHour: {
        startsAt: "2026-10-13T20:03:59.000Z",
        resetsAt: "2026-10-14T01:03:59.000Z",
        limitMicroCents: "1200000000",
        usedMicroCents: "1266977",
      },
      week: {
        startsAt: "2026-10-12T00:00:00.000Z",
        resetsAt: "2026-10-19T00:00:00.000Z",
        limitMicroCents: "3000000000",
        usedMicroCents: "1266977",
      },
      month: {
        resetsAt: "2026-11-04T05:55:52.000Z",
        limitMicroCents: "6000000000",
        usedMicroCents: "1266977",
      },
    },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("OpenCode Go parses console status meters", () => {
  const windows = parseOpenCodeGoStatus(SAMPLE_STATUS);
  assert.deepEqual(
    windows.map(({ label, precision, resetsAt }) => ({
      label,
      precision,
      reset: resetsAt?.toISOString(),
    })),
    [
      { label: "5h", precision: undefined, reset: "2026-10-14T01:03:59.000Z" },
      { label: "7d", precision: undefined, reset: "2026-10-19T00:00:00.000Z" },
      { label: "30d", precision: undefined, reset: "2026-11-04T05:55:52.000Z" },
    ],
  );
  assert.ok(
    Math.abs(
      windows[0].percentRemaining - (100 - (1_266_977 / 1_200_000_000) * 100),
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      windows[1].percentRemaining - (100 - (1_266_977 / 3_000_000_000) * 100),
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(
      windows[2].percentRemaining - (100 - (1_266_977 / 6_000_000_000) * 100),
    ) < 1e-9,
  );
});

test("OpenCode Go tolerates partial meter data and rejects odd values", () => {
  const windows = parseOpenCodeGoStatus({
    access: {
      meters: {
        fiveHour: {
          resetsAt: "2026-10-14T01:03:59.000Z",
          limitMicroCents: "1200000000",
          usedMicroCents: "1200000000",
        },
        week: { limitMicroCents: "broken", usedMicroCents: "0" },
        month: null,
      },
    },
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].label, "5h");
  assert.equal(windows[0].percentRemaining, 0);

  assert.deepEqual(
    parseOpenCodeGoStatus({
      access: {
        meters: {
          fiveHour: { limitMicroCents: "1200000000", usedMicroCents: "" },
          week: { limitMicroCents: true, usedMicroCents: "0" },
        },
      },
    }),
    [],
  );
});

test("OpenCode Go adapter reports missing settings without fetching", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  globalThis.fetch = async () => assert.fail("fetch must not run");

  assert.equal(
    (await createOpenCodeGoQuotaAdapter({ workspaceId: "wrk_1" }).getQuota({}))
      ?.error,
    "opencode-go: set pi-statusline.auth.json authToken",
  );
  assert.equal(
    (await createOpenCodeGoQuotaAdapter({ authToken: "secret" }).getQuota({}))
      ?.error,
    "opencode-go: set workspaceId",
  );
  assert.equal(
    (await createOpenCodeGoQuotaAdapter({}).getQuota({}))?.error,
    "opencode-go: set workspaceId + pi-statusline.auth.json authToken",
  );
});

test("OpenCode Go adapter sends only the Bearer token and workspace ID", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  const adapter = createOpenCodeGoQuotaAdapter({
    authToken: "secret",
    workspaceId: "wrk_1",
  });

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(url, "https://opencode.ai/console/api/go/status");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret");
    assert.equal(headers.get("x-org-id"), "wrk_1");
    assert.equal(headers.get("cookie"), null);
    return json(SAMPLE_STATUS);
  }) as typeof fetch;
  const status = await adapter.getQuota({});
  assert.equal(status?.error, undefined);
  assert.deepEqual(
    status?.windows.map(({ label }) => label),
    ["5h", "7d", "30d"],
  );
});

test("OpenCode Go adapter reports each failure clearly", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  const adapter = createOpenCodeGoQuotaAdapter({
    authToken: "secret",
    workspaceId: "wrk_1",
  });

  globalThis.fetch = async () => json({ _tag: "Unauthorized" }, 401);
  await assert.rejects(adapter.getQuota({}), {
    message: "OpenCode Go auth invalid or session expired",
  });

  globalThis.fetch = async () => json({ _tag: "OrgRequired" }, 400);
  assert.equal(
    (await adapter.getQuota({}))?.error,
    "opencode-go: workspace ID rejected (OrgRequired)",
  );

  globalThis.fetch = async () => json({ _tag: "SomethingNew" }, 400);
  await assert.rejects(adapter.getQuota({}), {
    message: "OpenCode Go status error 400 (SomethingNew)",
  });

  globalThis.fetch = async () => new Response("", { status: 404 });
  await assert.rejects(adapter.getQuota({}), {
    message: "OpenCode Go status error 404",
  });

  globalThis.fetch = async () =>
    new Response("<html>login</html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  await assert.rejects(adapter.getQuota({}), {
    message:
      "OpenCode Go returned an unexpected response (text/html; charset=utf-8)",
  });

  globalThis.fetch = async () => json({ access: { meters: {} } });
  assert.equal(
    (await adapter.getQuota({}))?.error,
    "opencode-go: no usage meters (no active plan, or the API changed)",
  );

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(adapter.getQuota({}), {
    message: "OpenCode Go quota fetch failed: fetch failed",
  });
});
