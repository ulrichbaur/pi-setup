import assert from "node:assert/strict";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

async function collect(pattern: string): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob(pattern)) files.push(file);
  return files.sort();
}

test("every extension entry point loads and exports a default function", async () => {
  const entries = [
    ...(await collect("extensions/*.ts")),
    ...(await collect("extensions/*/index.ts")),
  ];
  assert.ok(entries.length >= 10, `found ${entries.length} entry points`);

  for (const entry of entries) {
    const module = await import(pathToFileURL(resolve(entry)).href);
    assert.equal(typeof module.default, "function", entry);
  }
});
