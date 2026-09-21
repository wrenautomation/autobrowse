/**
 * Work Restate holds for this worker: invocations of its services that are
 * queued, running or retrying. A box with work queued is not idle even when
 * nothing has reached it yet (it just booted; the tunnel is registering),
 * so the idle stop asks here before it stops the machine. Suspended
 * invocations (a run waiting on a person) and scheduled ones do not count:
 * those resume from the journal on the next boot.
 */
import type { HttpClient } from "../clients/http.js";

const QUEUED = ["pending", "ready", "running", "backing-off"] as const;

export interface PendingOptions {
  adminUrl: string;
  authToken: string | null;
  http: HttpClient;
  /** The services this worker serves, as Restate names them. */
  services: readonly string[];
}

/** How many invocations of these services Restate is holding for the worker right now. */
export async function pendingInvocations(o: PendingOptions): Promise<number> {
  const list = (xs: readonly string[]) => xs.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  const query = `SELECT COUNT(*) AS n FROM sys_invocation WHERE target_service_name IN (${list(o.services)}) AND status IN (${list(QUEUED)})`;
  const r = await o.http.json<{ rows: Array<{ n: number | string }> }>(
    `${o.adminUrl.replace(/\/$/, "")}/query`,
    {
      method: "POST",
      headers: o.authToken ? { authorization: `Bearer ${o.authToken}` } : {},
      body: { query },
    },
  );
  if (!r.ok || !r.body) throw new Error(`restate admin: query HTTP ${r.status}`);
  return Number(r.body.rows[0]?.n ?? 0);
}
