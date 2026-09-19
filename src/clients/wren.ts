/**
 * The one-way coupling to wren: reload its roster (a fresh deploy reads the
 * SSM parameter at cold start) and start the per-inbox loops through the
 * Restate ingress. No imports from wren; the handler names are the contract.
 */
import { type HttpClient, HttpError } from "./http.js";

export interface WrenClient {
  /** Dispatch wren's deploy workflow so the next invocations load the new roster. */
  redeploy(): Promise<void>;
  /** The state of the deploy runs dispatched since `since`. One check, no waiting: the flow sleeps durably between calls. */
  deployState(since: Date): Promise<"pending" | "success" | "failed">;
  startLoops(address: string): Promise<{ send: boolean; inbox: boolean }>;
}

interface WorkflowRun {
  created_at: string;
  status: string;
  conclusion: string | null;
}

export function wrenClient(opts: {
  ingressUrl: string;
  authToken: string | null;
  githubToken: string | null;
  repo: string;
  http: HttpClient;
}): WrenClient {
  const github = <T>(path: string, method: "GET" | "POST", body?: unknown) => {
    if (!opts.githubToken) throw new Error("GITHUB_TOKEN unset: cannot redeploy wren");
    return opts.http.json<T>(`https://api.github.com/repos/${opts.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.githubToken}`,
        accept: "application/vnd.github+json",
      },
      ...(body === undefined ? {} : { body }),
    });
  };
  const ingress = async (path: string) => {
    const url = `${opts.ingressUrl}${path}`;
    const r = await opts.http.json<{ running?: boolean; onRoster?: boolean }>(url, {
      method: "POST",
      raw: "null",
      headers: {
        "content-type": "application/json",
        ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}),
      },
    });
    if (!r.ok) throw new HttpError("POST", url, r.status, "wren ingress");
    return r.body ?? {};
  };
  return {
    async redeploy() {
      const r = await github("/actions/workflows/deploy.yml/dispatches", "POST", { ref: "main" });
      if (r.status !== 204)
        throw new HttpError("POST", "https://api.github.com/dispatches", r.status, "wren redeploy");
    },
    async deployState(since) {
      const r = await github<{ workflow_runs?: WorkflowRun[] }>(
        "/actions/workflows/deploy.yml/runs?per_page=3&event=workflow_dispatch",
        "GET",
      );
      const fresh = (r.body?.workflow_runs ?? []).filter((x) => new Date(x.created_at) >= since);
      if (fresh.some((x) => x.status === "completed" && x.conclusion === "success"))
        return "success";
      if (fresh.some((x) => x.status === "completed")) return "failed";
      return "pending";
    },
    async startLoops(address) {
      const send = await ingress(`/SendScheduler/${encodeURIComponent(address)}/start`);
      const inbox = await ingress(`/InboxScheduler/${encodeURIComponent(address)}/start`);
      return { send: send.running === true, inbox: inbox.running === true };
    },
  };
}
