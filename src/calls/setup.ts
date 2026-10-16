/**
 * Turns on OBS's own websocket server (obs-websocket, inside OBS 28+) by writing its config
 * file, the one OBS reads at start: no clicks, keys or dialogs. The password is kept (or made
 * once) there and in the credential store as `obs`; never printed. OBS must be closed: it writes
 * this file back on quit.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const OBS_CREDENTIAL = "obs";
export const OBS_PORT = 4455;
export const OBS_URL = `ws://127.0.0.1:${OBS_PORT}`;

export const obsConfigDir = (home = homedir()) =>
  join(home, "Library/Application Support/obs-studio");
export const websocketConfigPath = (home = homedir()) =>
  join(obsConfigDir(home), "plugin_config/obs-websocket/config.json");

/** obs-websocket's config file, as OBS 32 writes it. */
export interface WebsocketConfig {
  alerts_enabled?: boolean;
  auth_required?: boolean;
  first_load?: boolean;
  server_enabled?: boolean;
  server_password?: string;
  server_port?: number;
  [k: string]: unknown;
}

/**
 * The config with the server on, loopback port 4455, auth on and no tray alerts. A password
 * already there is kept, so a client set up by hand still connects; else one is made.
 */
export function enabledConfig(
  was: WebsocketConfig,
  makePassword = () => randomBytes(18).toString("base64url"),
): WebsocketConfig {
  return {
    ...was,
    alerts_enabled: false,
    auth_required: true,
    first_load: false,
    server_enabled: true,
    server_port: OBS_PORT,
    server_password: was.server_password || makePassword(),
  };
}

/** Writes it (atomically) and gives back the password; the caller stores it. */
export async function enableWebsocket(
  home = homedir(),
): Promise<{ password: string; changed: boolean }> {
  const path = websocketConfigPath(home);
  const was = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as WebsocketConfig;
  const next = enabledConfig(was);
  const changed = JSON.stringify(next) !== JSON.stringify(was);
  if (changed) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 4)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  }
  return { password: next.server_password as string, changed };
}
