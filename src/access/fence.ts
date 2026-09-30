/**
 * The door check for an agent key on the HTTP API: each route an agent may
 * call and what it needs; every other route is the operator's. Lists an agent
 * reads are cut to its scope by their handlers (`visibleRun` and the rest);
 * this decides whether the request gets in at all.
 */
import { allowsSite, allowsWorkflow, can, type Scope, seesSite } from "./keys.js";

export interface FenceLookups {
  /** An agent session's site, or null when there is no such session. */
  sessionSite(id: string): string | null;
}

/** Reads every scope may make: each answers with only what the scope may use. */
const OPEN_READS = new Set([
  "/api/status",
  "/api/abilities",
  "/api/workflows",
  "/api/sites",
  "/api/runs",
  "/api/jobs",
  "/api/agent",
  "/api/events",
  "/api/settings",
]);

/** Why the request is refused, or null when it may go on. */
export function refusal(
  scope: Scope,
  method: string,
  path: string,
  query: Record<string, string>,
  look: FenceLookups,
): string | null {
  if (scope.operator) return null;
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  const get = method === "GET" || method === "HEAD";
  if (get && OPEN_READS.has(path.replace(/\/$/, ""))) return null;
  const [, head, a, b, c, d] = seg;
  const verb = (v: Parameters<typeof can>[1]) => (can(scope, v) ? null : `this key may not ${v}`);
  const site = (s: string) => (allowsSite(scope, s) ? null : `this key may not use ${s}`);
  const workflow = (w: string) => (allowsWorkflow(scope, w) ? null : `this key may not run ${w}`);

  if (head === "do" && !a && method === "POST") return verb("do");
  if (head === "jobs" && a && !b && get) return null; // the handler shows only the key's own jobs
  if (head === "sites" && a) {
    if (b === "setup") return "setup makes keys and tokens: the operator's";
    if (!b && get) return seesSite(scope, a) ? null : `this key may not use ${a}`;
    return verb("sites") ?? site(query.account ? `${a}@${query.account}` : a);
  }
  if (head === "runs" && a && b) {
    if (get && !c) return workflow(a);
    if (method !== "POST" || d) return "not an agent route";
    if (c === "approve" || c === "reject") return "gates are the operator's to answer";
    return verb("run") ?? workflow(a);
  }
  if (head === "agent") {
    if (!a) return method === "POST" ? verb("agent") : null; // the site is checked on the body
    if (a === "proposals" || a === "heal" || a === "repair") return "the operator's";
    if (b === "exec") return "a hand-typed command (eval, open anywhere) is the operator's";
    const s = look.sessionSite(a);
    if (!s) return null; // 404 from the handler
    return verb("agent") ?? site(s);
  }
  return "the operator's";
}
