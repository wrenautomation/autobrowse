/**
 * The ops Discord lane (#ops, `WREN_DISCORD_WEBHOOK_URL`): system notices from the worker.
 * Read, not alerted: a line pings `WREN_DISCORD_PING_USER_ID` only when it needs a person.
 * `deploy/desk/update.mjs` posts the same way (plain JS, outside the build).
 */
import type { HttpClient } from "../clients/http.js";

export type OpsLane = (text: string, o?: { ping?: boolean }) => Promise<void>;

/** The lane, or null when no webhook is set. */
export function opsLane(
  http: HttpClient,
  env: (name: string) => string | undefined = (n) => process.env[n],
): OpsLane | null {
  const url = env("WREN_DISCORD_WEBHOOK_URL");
  if (!url) return null;
  const user = env("WREN_DISCORD_PING_USER_ID");
  return async (text, o = {}) => {
    const ping = o.ping && user ? user : null;
    const r = await http.json(url, {
      method: "POST",
      body: {
        content: `${ping ? `<@${ping}> ` : ""}${text}`.slice(0, 2000),
        allowed_mentions: { parse: [], users: ping ? [ping] : [] },
      },
    });
    if (!r.ok) throw new Error(`discord webhook: HTTP ${r.status}`);
  };
}
