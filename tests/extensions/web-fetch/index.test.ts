import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fetchAndExtract } from "../../../extensions/web-fetch/index.ts";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

test("fetches plain text over HTTP", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("# Local document\n\nUseful content.");
  });
  const port = await listen(server);

  try {
    const result = await fetchAndExtract(`http://127.0.0.1:${port}/doc.txt`);
    assert.equal(result.error, null);
    assert.equal(result.title, "Local document");
    assert.match(result.content, /Useful content/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("extracts readable HTML as Markdown", async () => {
  const paragraph = "Readable article content. ".repeat(30);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<html><head><title>Article title</title></head><body><main><h1>Heading</h1><p>${paragraph}</p></main></body></html>`,
    );
  });
  const port = await listen(server);

  try {
    const result = await fetchAndExtract(`http://127.0.0.1:${port}/article`);
    assert.equal(result.error, null);
    assert.equal(result.title, "Article title");
    assert.match(result.content, /^#{1,2} Heading/m);
    assert.match(result.content, /Readable article content/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("rejects oversized web responses", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-length": String(6 * 1024 * 1024),
      "content-type": "text/plain",
    });
    response.end();
  });
  const port = await listen(server);

  try {
    const result = await fetchAndExtract(`http://127.0.0.1:${port}/large.txt`);
    assert.match(result.error ?? "", /Response too large/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("rejects non-HTTP fetch URLs", async () => {
  const result = await fetchAndExtract("file:///etc/passwd");
  assert.equal(result.error, "URL must use HTTP or HTTPS");
});

test("a failed fetch contacts no other host", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  const requested: string[] = [];
  globalThis.fetch = async (input, init) => {
    requested.push(String(input));
    return originalFetch(input, init);
  };
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end("missing");
  });
  const port = await listen(server);

  try {
    const url = `http://127.0.0.1:${port}/gone`;
    const result = await fetchAndExtract(url);
    assert.match(result.error ?? "", /^HTTP 404/);
    assert.deepEqual(requested, [url]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("JavaScript-rendered pages fail with an explicit hint", async () => {
  const scripts = '<script src="a.js"></script>'.repeat(4);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<html><head><title>App</title>${scripts}</head><body><div id="root"></div></body></html>`,
    );
  });
  const port = await listen(server);

  try {
    const result = await fetchAndExtract(`http://127.0.0.1:${port}/app`);
    assert.match(result.error ?? "", /JavaScript-rendered/);
    assert.match(result.error ?? "", /web_search/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
