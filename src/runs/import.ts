/**
 * Site calls from before the call ledger, into it: what Restate still holds
 * (about a day of finished `sites`/`desk` invocations, the route read off the
 * journaled step's name) and the caps ledger (metered reads, 14 days). One
 * row per call, marked `from`, never a call the ledger already has.
 */
import type { HttpClient } from "../clients/http.js";
import type { MeteredCall } from "../sites/caps.js";
import type { SiteCallRow } from "./calls.js";

/** A finished invocation as the admin query answers it. */
export interface FinishedInvocation {
  id: string;
  service: string;
  created_at: string;
  modified_at?: string;
  completion_result?: string;
  completion_failure?: string;
  retry_count?: number | string;
  invoked_by_target?: string;
  /** The `ctx.run` step: `sites <site> <METHOD> <path>`. */
  name?: string;
}

/** `[400] Too big: …` → 400 and the message. */
function failureOf(text: string | undefined): { status: number | null; error: string } {
  const m = /^\[(\d{3})\]\s*([\s\S]*)$/.exec(text ?? "");
  return m ? { status: Number(m[1]), error: m[2] as string } : { status: null, error: text ?? "" };
}

export function fromRestate(rows: readonly FinishedInvocation[]): SiteCallRow[] {
  const out: SiteCallRow[] = [];
  for (const r of rows) {
    const m = /^sites (\S+) ([A-Z]+ \S+)/.exec(r.name ?? "");
    if (!m) continue;
    const ok = r.completion_result === "success";
    const f = ok ? { status: null, error: null } : failureOf(r.completion_failure);
    const end = r.modified_at ? Date.parse(r.modified_at) : Date.parse(r.created_at);
    out.push({
      at: r.created_at,
      service: r.service,
      site: m[1] as string,
      route: m[2] as string,
      caller: r.invoked_by_target ?? null,
      invocation: r.id,
      attempt: Number(r.retry_count ?? 0) + 1,
      ok,
      status: f.status,
      // A finished invocation's failure reached its caller.
      terminal: !ok,
      error: f.error,
      ms: Math.max(0, end - Date.parse(r.created_at)),
      from: "restate",
    });
  }
  return out;
}

/** `capped` and `paced` spent nothing and answered 429; `failed` spent the read and got no answer. */
export function fromCaps(calls: readonly MeteredCall[], service = "desk"): SiteCallRow[] {
  return calls.map((c) => ({
    at: c.at,
    service,
    site: c.site,
    route: c.route,
    caller: c.caller,
    invocation: c.invocation ?? null,
    attempt: 1,
    ok: c.outcome === "ok",
    status: c.outcome === "ok" ? null : c.outcome === "failed" ? 502 : 429,
    terminal: c.outcome !== "ok",
    error: c.outcome === "ok" ? null : `${c.outcome}${c.bucket ? ` (${c.bucket})` : ""}`,
    ms: 0,
    from: "caps" as const,
  }));
}

/**
 * New rows only: an invocation the ledger or Restate already has is skipped.
 * The caps ledger notes every try, so one invocation there can be several
 * rows; they stay, numbered as attempts.
 */
export function newRows(
  have: readonly SiteCallRow[],
  restate: readonly SiteCallRow[],
  caps: readonly SiteCallRow[],
): SiteCallRow[] {
  const had = new Set(have.map((r) => r.invocation).filter(Boolean));
  const out = restate.filter((r) => !r.invocation || !had.has(r.invocation));
  for (const r of out) if (r.invocation) had.add(r.invocation);
  const tries = new Map<string, number>();
  for (const r of [...caps].sort((a, b) => a.at.localeCompare(b.at))) {
    if (r.invocation && had.has(r.invocation)) continue;
    const attempt = r.invocation ? (tries.get(r.invocation) ?? 0) + 1 : 1;
    if (r.invocation) tries.set(r.invocation, attempt);
    out.push({ ...r, attempt });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Finished calls of these services Restate still holds, with each one's step name. */
export async function finishedCalls(o: {
  /** The admin API: `<ingress>/admin` on the box, or RESTATE_ADMIN_URL. */
  adminUrl: string;
  authToken: string | null;
  http: HttpClient;
  services: readonly string[];
}): Promise<FinishedInvocation[]> {
  const list = o.services.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  const query = `SELECT i.id, i.target_service_name AS service, i.created_at, i.modified_at, i.completion_result, i.completion_failure, i.retry_count, i.invoked_by_target, j.name FROM sys_invocation i JOIN sys_journal j ON j.id = i.id WHERE i.target_service_name IN (${list}) AND i.target_handler_name = 'call' AND i.status = 'completed' AND j.name LIKE 'sites %'`;
  const r = await o.http.json<{ rows: FinishedInvocation[] }>(
    `${o.adminUrl.replace(/\/$/, "")}/query`,
    {
      method: "POST",
      headers: o.authToken ? { authorization: `Bearer ${o.authToken}` } : {},
      body: { query },
    },
  );
  if (!r.ok || !r.body) throw new Error(`restate admin: query HTTP ${r.status}`);
  return r.body.rows;
}
