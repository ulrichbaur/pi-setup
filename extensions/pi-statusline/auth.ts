/** Loads and updates the OpenCode Go auth token in the statusline's local secret file. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../../lib/is-record.ts";
import { AUTH_PATH } from "./config.ts";

// Keep secrets out of the regular config and its diagnostic command output.
export async function loadOpenCodeGoAuthToken(
  path = AUTH_PATH,
): Promise<string | undefined> {
  const auth = await loadAuth(path);
  const opencodeGo = isRecord(auth) ? auth.opencodeGo : undefined;
  const token = isRecord(opencodeGo) ? opencodeGo.authToken : undefined;
  return typeof token === "string" && token.trim() ? token.trim() : undefined;
}

// Update only this extension's credential so future secret fields survive unchanged.
export async function saveOpenCodeGoAuthToken(
  token: string,
  path = AUTH_PATH,
): Promise<void> {
  const auth = await loadAuth(path);
  const opencodeGo = isRecord(auth.opencodeGo) ? auth.opencodeGo : {};
  auth.opencodeGo = { ...opencodeGo, authToken: token.trim() };

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
  let auth: unknown;
  try {
    auth = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    // No secret file simply leaves the OpenCode Go quota unconfigured.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${message}`);
  }
  if (isRecord(auth)) return auth;
  throw new Error(`${path}: expected a JSON object`);
}
