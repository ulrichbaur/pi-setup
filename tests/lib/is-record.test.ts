import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "../../lib/is-record.ts";

test("isRecord accepts plain objects only", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ key: 1 }), true);
  for (const value of [null, undefined, [], "text", 1, true])
    assert.equal(isRecord(value), false);
});
