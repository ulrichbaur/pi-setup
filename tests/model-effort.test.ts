import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

const directory = await mkdtemp(join(tmpdir(), "model-effort-test-"));
const preferencesFile = join(directory, "model-effort.json");
process.env.PI_CODING_AGENT_DIR = directory;

const { default: modelEffort } = await import("../extensions/model-effort.ts");

before(async () => {
  await rm(preferencesFile, { force: true });
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function model(
  provider: string,
  id: string,
  supported: ThinkingLevel[] = ["minimal", "low", "medium", "high"],
): Model<any> {
  const all = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const;
  return {
    provider,
    id,
    reasoning: true,
    thinkingLevelMap: Object.fromEntries(
      all.map((level) => [
        level,
        level === "off" || supported.includes(level as ThinkingLevel)
          ? level
          : null,
      ]),
    ),
  } as Model<any>;
}

function fakePi(initialLevel: ThinkingLevel = "medium") {
  const handlers = new Map<string, (...args: any[]) => void>();
  let level = initialLevel;
  const selected: ThinkingLevel[] = [];

  return {
    pi: {
      on(name: string, handler: (...args: any[]) => void) {
        handlers.set(name, handler);
      },
      getThinkingLevel() {
        return level;
      },
      setThinkingLevel(next: ThinkingLevel) {
        level = next;
        selected.push(next);
      },
    } as any,
    handlers,
    selected,
    level: () => level,
  };
}

async function waitForWrites(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(preferencesFile, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("preference file was not written");
}

test("saves and applies the first supported level for a new model", async () => {
  await rm(preferencesFile, { force: true });
  const fake = fakePi("high");
  await modelEffort(fake.pi);
  const current = model("provider-a", "model-a", ["low", "high"]);

  fake.handlers.get("session_start")?.({}, { model: current });
  await waitForWrites();

  assert.equal(fake.level(), "low");
  assert.deepEqual(fake.selected, ["low"]);
  assert.deepEqual(JSON.parse(await readFile(preferencesFile, "utf8")), {
    "provider-a/model-a": "low",
  });
});

test("restores the closest supported level below a saved level", async () => {
  await writeFile(
    preferencesFile,
    JSON.stringify({ "provider-a/model-a": "high" }),
  );
  const fake = fakePi("medium");
  await modelEffort(fake.pi);
  const current = model("provider-a", "model-a", ["minimal", "low"]);

  fake.handlers.get("model_select")?.({ model: current });

  assert.equal(fake.level(), "low");
});

test("records user changes only for the active model", async () => {
  await rm(preferencesFile, { force: true });
  const fake = fakePi();
  await modelEffort(fake.pi);
  const active = model("provider-a", "model-a");
  const other = model("provider-a", "model-b");

  fake.handlers.get("model_select")?.({ model: active });
  await waitForWrites();
  fake.handlers.get("thinking_level_select")?.(
    { level: "high" },
    { model: other },
  );
  fake.handlers.get("thinking_level_select")?.(
    { level: "off" },
    { model: active },
  );
  fake.handlers.get("thinking_level_select")?.(
    { level: "high" },
    { model: active },
  );

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const saved = JSON.parse(await readFile(preferencesFile, "utf8"));
    if (saved["provider-a/model-a"] === "high") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(JSON.parse(await readFile(preferencesFile, "utf8")), {
    "provider-a/model-a": "high",
  });
});

test("ignores malformed preference files", async () => {
  await writeFile(preferencesFile, "not json");
  const fake = fakePi("high");

  await modelEffort(fake.pi);
  fake.handlers.get("session_start")?.(
    {},
    { model: model("provider-b", "model-b") },
  );

  assert.equal(fake.level(), "minimal");
});
