import assert from "node:assert/strict";
import { test } from "node:test";
import { createQuotaAdapters } from "../../../extensions/pi-statusline/index.ts";

const allQuotas = { quotas: { codex: true, opencodeGo: true } };

test("a broken config turns all quotas off", () => {
  assert.deepEqual(createQuotaAdapters(undefined, {}), []);
});

test("a broken auth file shows its error in the OpenCode Go slot only", async () => {
  const adapters = createQuotaAdapters(allQuotas, {
    error: "/agent/pi-statusline.auth.json: Unexpected token",
  });
  assert.deepEqual(
    adapters.map(({ provider }) => provider),
    ["codex", "opencode-go"],
  );
  assert.equal(
    (await adapters[1].getQuota({}))?.error,
    "opencode-go: /agent/pi-statusline.auth.json: Unexpected token",
  );
});

test("disabled quotas create no adapters", () => {
  assert.deepEqual(
    createQuotaAdapters({ quotas: { codex: false, opencodeGo: false } }, {}),
    [],
  );
});
