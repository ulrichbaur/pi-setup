import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSearchQuery } from "../../../extensions/web-search/index.ts";

test("builds a structured Google search query", () => {
  assert.deepEqual(
    buildSearchQuery({
      query: "  pi extensions  ",
      exactPhrases: ['"custom tools"'],
      excludeTerms: ["old docs"],
      site: "https://pi.dev/docs/",
    }),
    {
      query: 'pi extensions "custom tools" -"old docs" site:pi.dev',
      baseQuery: "pi extensions",
      exactPhrases: ["custom tools"],
      excludeTerms: ["old docs"],
      site: "pi.dev",
    },
  );
});

test("requires a search query or exact phrase", () => {
  assert.throws(
    () => buildSearchQuery({ excludeTerms: ["noise"] }),
    /At least one/,
  );
});
