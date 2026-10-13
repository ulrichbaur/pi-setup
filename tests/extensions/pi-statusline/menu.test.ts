import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadOpenCodeGoAuthToken } from "../../../extensions/pi-statusline/auth.ts";
import {
  loadConfig,
  type StatuslineConfig,
} from "../../../extensions/pi-statusline/config.ts";
import {
  commitStatuslineChanges,
  showStatuslineMenu,
} from "../../../extensions/pi-statusline/menu.ts";
import { withTempDir } from "../../helpers.ts";

test("commitStatuslineChanges leaves auth untouched when it was not changed", () =>
  withTempDir("pi-statusline-", async (dir) => {
    const authPath = join(dir, "auth.json");
    const original = '{ "opencodeGo": { "authToken": "old" } }\n';
    await writeFile(authPath, original);

    await commitStatuslineChanges({
      config: { quotas: { codex: true, opencodeGo: false } },
      authToken: "replacement",
      authTokenChanged: false,
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
      authToken: "secret-token",
      authTokenChanged: true,
      configPath,
      authPath,
    });

    assert.deepEqual(await loadConfig(configPath), config);
    assert.equal(await loadOpenCodeGoAuthToken(authPath), "secret-token");
  }));

test("an empty entry keeps the current workspace ID and token", async () => {
  const actions = ["edit-workspace", "edit-auth", "save"];
  const inputs = ["", "  "];
  const placeholders: string[] = [];
  const initial = {
    config: {
      quotas: { codex: true, opencodeGo: true },
      opencodeGo: { workspaceId: "wrk_1" },
    },
    authToken: "token",
    authTokenChanged: false,
    configPath: "config.json",
    authPath: "auth.json",
  };
  const final = await showStatuslineMenu(initial, {
    ui: {
      custom: async () => ({ kind: actions.shift() }),
      input: async (_title: string, placeholder: string) => {
        placeholders.push(placeholder);
        return inputs.shift();
      },
    },
  } as any);
  assert.deepEqual(final, initial);
  assert.match(placeholders[0], /^wrk_1 \(leave empty to keep\)$/);
});

test("a new entry replaces the workspace ID and token", async () => {
  const actions = ["edit-workspace", "edit-auth", "save"];
  const inputs = [" wrk_2 ", " new-token "];
  const final = await showStatuslineMenu(
    {
      config: { quotas: { codex: true, opencodeGo: true } },
      authToken: undefined,
      authTokenChanged: false,
      configPath: "config.json",
      authPath: "auth.json",
    },
    {
      ui: {
        custom: async () => ({ kind: actions.shift() }),
        input: async () => inputs.shift(),
      },
    } as any,
  );
  assert.equal(final?.config.opencodeGo?.workspaceId, "wrk_2");
  assert.equal(final?.authToken, "new-token");
  assert.equal(final?.authTokenChanged, true);
});
