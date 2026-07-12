/** Loads and updates the OpenCode Go cookie in the statusline's local secret file. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AUTH_PATH } from "./config.ts";

// Keep secrets out of the regular config and its diagnostic command output.
export async function loadOpenCodeGoAuthCookie(
  path = AUTH_PATH,
): Promise<string | undefined> {
  const auth = await loadAuth(path);
  const opencodeGo = isRecord(auth) ? auth.opencodeGo : undefined;
  const cookie = isRecord(opencodeGo) ? opencodeGo.authCookie : undefined;
  return typeof cookie === "string" && cookie.trim()
    ? cookie.trim()
    : undefined;
}

// Update only this extension's credential so future secret fields survive unchanged.
export async function saveOpenCodeGoAuthCookie(
  cookie: string,
  path = AUTH_PATH,
): Promise<void> {
  const auth = await loadAuth(path);
  const opencodeGo = isRecord(auth.opencodeGo) ? auth.opencodeGo : {};
  auth.opencodeGo = { ...opencodeGo, authCookie: cookie.trim() };

  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function loadAuth(path: string): Promise<Record<string, unknown>> {
  try {
    const auth = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isRecord(auth)) return auth;
    throw new Error(`${path}: expected a JSON object`);
  } catch (error) {
    // No secret file simply leaves the OpenCode Go quota unconfigured.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
