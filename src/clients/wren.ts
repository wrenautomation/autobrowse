/**
 * The one-way coupling to wren: reload its roster (a fresh deploy reads the
 * SSM parameter at cold start) and start the per-inbox loops through the
 * Restate ingress. No imports from wren; the handler names are the contract.
 */
import type { FetchLike } from "../google-auth.js";

export interface WrenClient {
  /** Dispatch wren's deploy workflow so the next invocations load the new roster. */
  redeploy(): Promise<void>;
  /** Wait until a deployment newer than `since` has finished; false on timeout. */
  awaitDeploy(since: Date, timeoutMs: number): Promise<boolean>;
  startLoops(address: string): Promise<{ send: boolean; inbox: boolean }>;
}

export function wrenClient(opts: {
  ingressUrl: string;
  authToken: string | null;
  githubToken: string | null;
  repo: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}): WrenClient {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const gh = (path: string, init: RequestInit = {}) => {
    if (!opts.githubToken) throw new Error("GITHUB_TOKEN unset: cannot redeploy wren");
    return doFetch(`https://api.github.com/repos/${opts.repo}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.githubToken}`,
        accept: "application/vnd.github+json",
        ...(init.headers ?? {}),
      },
    });
  };
  const ingress = async (path: string) => {
    const r = await doFetch(`${opts.ingressUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
      },
      body: "null",
    });
    if (!r.ok) throw new Error(`wren ingress ${path}: HTTP ${r.status}`);
    return (await r.json()) as { running?: boolean; onRoster?: boolean };
  };
  return {
    async redeploy() {
      const r = await gh("/actions/workflows/deploy.yml/dispatches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      });
      if (r.status !== 204) throw new Error(`wren redeploy dispatch: HTTP ${r.status}`);
    },
    async awaitDeploy(since, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await gh("/actions/workflows/deploy.yml/runs?per_page=3&event=workflow_dispatch");
        const runs =
          (
            (await r.json()) as {
              workflow_runs?: Array<{
                created_at: string;
                status: string;
                conclusion: string | null;
              }>;
            }
          ).workflow_runs ?? [];
        const fresh = runs.filter((x) => new Date(x.created_at) >= since);
        if (fresh.some((x) => x.status === "completed" && x.conclusion === "success")) return true;
        if (fresh.some((x) => x.status === "completed" && x.conclusion !== "success")) {
          throw new Error("wren deploy failed; see the Actions tab");
        }
        await sleep(20_000);
      }
      return false;
    },
    async startLoops(address) {
      const send = await ingress(`/SendScheduler/${encodeURIComponent(address)}/start`);
      const inbox = await ingress(`/InboxScheduler/${encodeURIComponent(address)}/start`);
      return { send: send.running === true, inbox: inbox.running === true };
    },
  };
}
