/**
 * Metered networks (designs/2026-10-26-metered-desk.md): on the iPhone hotspot the desk keeps
 * serving calls and holds its bulk work (trace and shot ships, shared-library sends and pulls,
 * presidio, re-proofs) until wifi. `~/.config/metered/metered.sh` is the one source of truth;
 * no script, no hold.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

export const METERED_SCRIPT = join(homedir(), ".config/metered/metered.sh");

/** The script's `status` line: `<auto|on|off> <metered|unmetered> <paused|running>`. */
export function holdsFrom(status: string): boolean {
  const [mode, net] = status.trim().split(/\s+/);
  // The second field is the hotspot check alone: the mode comes first.
  return mode === "on" || (mode === "auto" && net === "metered");
}

/** Whether bulk work waits now. A missing or failed script never holds. */
export function holdBulk(script = METERED_SCRIPT): Promise<boolean> {
  if (!existsSync(script)) return Promise.resolve(false);
  return new Promise((done) =>
    execFile("bash", [script, "status"], { timeout: 5_000 }, (err, out) =>
      done(err ? false : holdsFrom(out)),
    ),
  );
}

let held: boolean | undefined;

/** `holdBulk`, with one log line when the network changes, not one per timer tick. */
export async function holding(log: Logger, script = METERED_SCRIPT): Promise<boolean> {
  const now = await holdBulk(script);
  if (now !== (held ?? false))
    log.info({ metered: now }, now ? "metered: bulk work held" : "metered: bulk work resumed");
  held = now;
  return now;
}
