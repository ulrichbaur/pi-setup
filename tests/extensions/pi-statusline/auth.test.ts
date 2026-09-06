import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadOpenCodeGoAuthCookie,
  saveOpenCodeGoAuthCookie,
} from "../../../extensions/pi-statusline/auth.ts";
import { withTempDir } from "../../helpers.ts";

test("loads the OpenCode Go cookie only from its dedicated auth file", () =>
  withTempDir("pi-statusline-auth-", async (directory) => {
    const authFile = join(directory, "pi-statusline.auth.json");
    await writeFile(
      authFile,
      JSON.stringify({ opencodeGo: { authCookie: " cookie-value " } }),
    );
    assert.equal(await loadOpenCodeGoAuthCookie(authFile), "cookie-value");
    assert.equal(
      await loadOpenCodeGoAuthCookie(join(directory, "missing.json")),
      undefined,
    );
  }));

test("saves the OpenCode Go cookie without replacing other auth fields", () =>
  withTempDir("pi-statusline-auth-", async (directory) => {
    const authFile = join(directory, "pi-statusline.auth.json");
    await writeFile(
      authFile,
      JSON.stringify({
        other: { value: true },
        opencodeGo: { future: "keep" },
      }),
    );
    await saveOpenCodeGoAuthCookie(" cookie-value ", authFile);
    assert.deepEqual(JSON.parse(await readFile(authFile, "utf8")), {
      other: { value: true },
      opencodeGo: { future: "keep", authCookie: "cookie-value" },
    });
  }));
