import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
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
