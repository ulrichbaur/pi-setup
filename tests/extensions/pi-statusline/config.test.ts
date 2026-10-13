import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_CONFIG,
  loadConfig,
  type StatuslineConfig,
  saveConfig,
} from "../../../extensions/pi-statusline/config.ts";
import { withTempDir } from "../../helpers.ts";

test("saveConfig writes JSON, round-trips through loadConfig, and drops empty opencodeGo blocks", () =>
  withTempDir("pi-statusline-", async (dir) => {
    const configPath = join(dir, "config.json");
    const withWorkspace: StatuslineConfig = {
      quotas: { codex: false, opencodeGo: true },
      opencodeGo: { workspaceId: "ws-1" },
    };
    await saveConfig(withWorkspace, configPath);
    assert.deepEqual(await loadConfig(configPath), withWorkspace);

    await saveConfig(
      { quotas: { codex: false, opencodeGo: true }, opencodeGo: {} },
      configPath,
    );
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(raw.opencodeGo, undefined);
    assert.deepEqual(await loadConfig(configPath), {
      quotas: { codex: false, opencodeGo: true },
    });
  }));

test("loadConfig names the file when it is malformed or mistyped", () =>
  withTempDir("pi-statusline-", async (dir) => {
    const configPath = join(dir, "config.json");
    const rejects = async (content: string, message: RegExp) => {
      await writeFile(configPath, content);
      await assert.rejects(loadConfig(configPath), (error: Error) => {
        assert.ok(error.message.startsWith(`${configPath}: `), error.message);
        assert.match(error.message, message);
        return true;
      });
    };
    await rejects("{ not json", /JSON/);
    await rejects("[]", /config must be an object/);
    await rejects(
      '{ "quotas": { "codex": "no" } }',
      /quotas\.codex must be true or false/,
    );
    await rejects(
      '{ "opencodeGo": { "workspaceId": 7 } }',
      /opencodeGo\.workspaceId must be a string/,
    );
    assert.deepEqual(
      await loadConfig(join(dir, "missing.json")),
      DEFAULT_CONFIG,
    );
  }));
