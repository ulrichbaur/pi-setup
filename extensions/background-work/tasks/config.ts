import { readFile } from "node:fs/promises";
import type { KeyId } from "@earendil-works/pi-tui";
import { isRecord } from "../../../lib/is-record.ts";

const DEFAULT_SHORTCUT: KeyId = "alt+t";
const KEY =
  /^((?:(?:ctrl|alt|shift|super)\+)*)(?:[a-z0-9`=[\]\\;',./!@#$%^&*()_+|~{}:<>?-]|escape|esc|enter|return|tab|space|backspace|delete|insert|clear|home|end|pageUp|pageDown|up|down|left|right|f(?:[1-9]|1[0-2]))$/;

export async function loadShortcut(path: string): Promise<KeyId | false> {
  try {
    const config: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(config)) throw new Error("expected an object");
    const { shortcut } = config;
    if (shortcut === undefined) return DEFAULT_SHORTCUT;
    if (shortcut === false) return false;
    if (typeof shortcut === "string") {
      const match = KEY.exec(shortcut);
      if (match?.[0] === shortcut) {
        const modifiers = match[1].split("+");
        if (new Set(modifiers).size === modifiers.length)
          return shortcut as KeyId;
      }
    }
    throw new Error("shortcut must be a Pi keybinding or false");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return DEFAULT_SHORTCUT;
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
