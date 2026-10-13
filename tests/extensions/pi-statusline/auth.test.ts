import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadOpenCodeGoAuthToken,
  saveOpenCodeGoAuthToken,
} from "../../../extensions/pi-statusline/auth.ts";
import { withTempDir } from "../../helpers.ts";

test("loads the OpenCode Go token only from its dedicated auth file", () =>
  withTempDir("pi-statusline-auth-", async (directory) => {
    const authFile = join(directory, "pi-statusline.auth.json");
    await writeFile(
      authFile,
      JSON.stringify({ opencodeGo: { authToken: " token-value " } }),
    );
    assert.equal(await loadOpenCodeGoAuthToken(authFile), "token-value");
    assert.equal(
      await loadOpenCodeGoAuthToken(join(directory, "missing.json")),
      undefined,
    );
  }));

test("saves the OpenCode Go token without replacing other auth fields", () =>
  withTempDir("pi-statusline-auth-", async (directory) => {
    const authFile = join(directory, "pi-statusline.auth.json");
    await writeFile(
      authFile,
      JSON.stringify({
        other: { value: true },
        opencodeGo: { future: "keep" },
      }),
    );
    await saveOpenCodeGoAuthToken(" token-value ", authFile);
    assert.deepEqual(JSON.parse(await readFile(authFile, "utf8")), {
      other: { value: true },
      opencodeGo: { future: "keep", authToken: "token-value" },
    });
  }));

test("names the auth file when it is malformed", () =>
  withTempDir("pi-statusline-auth-", async (directory) => {
    const authFile = join(directory, "pi-statusline.auth.json");
    await writeFile(authFile, "{ not json");
    await assert.rejects(loadOpenCodeGoAuthToken(authFile), (error: Error) =>
      error.message.startsWith(`${authFile}: `),
    );
    await writeFile(authFile, "[]");
    await assert.rejects(loadOpenCodeGoAuthToken(authFile), {
      message: `${authFile}: expected a JSON object`,
    });
  }));
