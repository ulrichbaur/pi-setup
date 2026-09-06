import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadOpenCodeGoAuthCookie } from "../../../extensions/pi-statusline/auth.ts";
import {
  loadConfig,
  type StatuslineConfig,
} from "../../../extensions/pi-statusline/config.ts";
import { commitStatuslineChanges } from "../../../extensions/pi-statusline/menu.ts";
import { withTempDir } from "../../helpers.ts";

test("commitStatuslineChanges leaves auth untouched when it was not changed", () =>
  withTempDir("pi-statusline-", async (dir) => {
    const authPath = join(dir, "auth.json");
    const original = '{ "opencodeGo": { "authCookie": "old" } }\n';
    await writeFile(authPath, original);

    await commitStatuslineChanges({
      config: { quotas: { codex: true, opencodeGo: false } },
      authCookie: "replacement",
      authCookieChanged: false,
      configPath: join(dir, "config.json"),
      authPath,
    });
    assert.equal(await readFile(authPath, "utf8"), original);
  }));

test("commitStatuslineChanges writes to the paths in its menu state", () =>
  withTempDir("pi-statusline-", async (dir) => {
    const configPath = join(dir, "custom-config.json");
    const authPath = join(dir, "custom-auth.json");
    const config: StatuslineConfig = {
      quotas: { codex: false, opencodeGo: true },
    };

    await commitStatuslineChanges({
      config,
      authCookie: "secret-cookie",
      authCookieChanged: true,
      configPath,
      authPath,
    });

    assert.deepEqual(await loadConfig(configPath), config);
    assert.equal(await loadOpenCodeGoAuthCookie(authPath), "secret-cookie");
  }));
