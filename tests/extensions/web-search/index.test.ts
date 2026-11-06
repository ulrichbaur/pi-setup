import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch, {
  buildSearchQuery,
} from "../../../extensions/web-search/index.ts";

test("builds a structured Brave search query", () => {
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

test("Brave transport preserves search parameters, results, errors, and cancellation", async (t) => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_SEARCH_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalKey;
    if (originalGoogleKey === undefined)
      delete process.env.GOOGLE_SEARCH_API_KEY;
    else process.env.GOOGLE_SEARCH_API_KEY = originalGoogleKey;
  });
  process.env.BRAVE_SEARCH_API_KEY = "test-brave-secret";
  let tool: any;
  webSearch({
    registerTool: (definition: any) => {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  assert.equal(tool.name, "web_search");
  assert.match(tool.description, /Brave Search API/);
  const calls: Array<{ url: URL; options: RequestInit }> = [];
  let response: Response;
  let failure: Error | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string, options: RequestInit) => {
      calls.push({ url: new URL(input), options });
      if (failure) throw failure;
      return response;
    },
  );
  response = Response.json({
    web: {
      results: [
        {
          title: "Docs",
          url: "https://example.com/docs",
          description: "First\nsecond",
        },
        { title: "Other", url: "https://example.com/other" },
      ],
    },
  });
  const controller = new AbortController();
  const result = await tool.execute(
    "test",
    {
      query: "pi",
      exactPhrases: ["custom tools"],
      excludeTerms: ["old docs"],
      site: "example.com",
      count: 10,
    },
    controller.signal,
  );
  assert.equal(calls[0].url.origin, "https://api.search.brave.com");
  assert.equal(calls[0].url.pathname, "/res/v1/web/search");
  assert.equal(
    calls[0].url.searchParams.get("q"),
    'pi "custom tools" -"old docs" site:example.com',
  );
  assert.equal(calls[0].url.searchParams.get("count"), "10");
  assert.equal(calls[0].url.searchParams.get("result_filter"), "web");
  assert.equal(calls[0].url.searchParams.get("text_decorations"), "false");
  assert.equal(calls[0].url.searchParams.has("key"), false);
  assert.equal(calls[0].url.toString().includes("test-brave-secret"), false);
  assert.equal(
    new Headers(calls[0].options.headers).get("X-Subscription-Token"),
    "test-brave-secret",
  );
  assert.equal(calls[0].options.signal, controller.signal);
  assert.match(
    result.content[0].text,
    /Docs\n.*https:\/\/example.com\/docs\n.*First second/,
  );
  assert.equal(result.details.resultCount, 2);
  assert.equal(
    result.details.composedQuery,
    calls[0].url.searchParams.get("q"),
  );

  response = Response.json({});
  const empty = await tool.execute("test", { query: "missing" });
  assert.equal(empty.content[0].text, "No results found.");
  assert.equal(calls.at(-1)?.url.searchParams.get("count"), "5");
  for (const malformed of [
    null,
    [],
    { web: [] },
    { web: { results: null } },
    { web: { results: [{}] } },
  ]) {
    response = Response.json(malformed);
    await assert.rejects(
      tool.execute("test", { query: "invalid" }),
      /Brave Search API returned.*invalid/,
    );
  }
  for (const status of [401, 429, 500]) {
    response = new Response("Failed test-brave-secret", { status });
    await assert.rejects(
      tool.execute("test", { query: "failure" }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`Brave Search API ${status}`));
        assert.ok(!error.message.includes("test-brave-secret"));
        return true;
      },
    );
  }
  failure = new Error("request aborted");
  await assert.rejects(
    tool.execute("test", { query: "abort" }, controller.signal),
    /request aborted/,
  );
  const callCount = calls.length;
  delete process.env.BRAVE_SEARCH_API_KEY;
  process.env.GOOGLE_SEARCH_API_KEY = "legacy-google-key";
  await assert.rejects(
    tool.execute("test", { query: "missing key" }),
    /Set BRAVE_SEARCH_API_KEY/,
  );
  assert.equal(calls.length, callCount);
});
