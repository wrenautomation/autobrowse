/**
 * Instantly (API v2), for warmup only: sends go through wren. A Google
 * Workspace inbox joins by Instantly's OAuth session API: `oauthInit` hands
 * back Google's authorize URL, a browser signed in as the inbox consents,
 * `oauthStatus` says when Instantly has it. No Instantly login, no
 * dashboard. The key needs `accounts:create` and `accounts:read`
 * (`accounts:update` to turn warmup on).
 */
import { type HttpClient, safeUrl } from "./http.js";

const API = "https://api.instantly.ai/api/v2";

export interface InstantlyAccount {
  email: string;
  /** 1 active, 2 paused, negative = a connection error. */
  status: number;
  /** 1 on, 0 off, negative = warmup banned or erroring. */
  warmupStatus: number;
}

export type OauthStatus =
  | { status: "pending" }
  | { status: "success"; email: string }
  | { status: "error"; error: string; description: string }
  | { status: "expired" };

export interface InstantlyClient {
  /** The inbox as Instantly has it, or null when it is not in this workspace. */
  account(email: string): Promise<InstantlyAccount | null>;
  /** A 10-minute session and the Google authorize URL that feeds it. */
  oauthInit(): Promise<{ sessionId: string; authUrl: string }>;
  oauthStatus(sessionId: string): Promise<OauthStatus>;
  /** Starts a background job; returns its id. */
  enableWarmup(emails: string[]): Promise<string>;
  /** A background job's state: pending, in-progress, success, failed. */
  job(id: string): Promise<string>;
}

export class InstantlyError extends Error {
  readonly status: number;
  constructor(what: string, status: number, message?: string) {
    super(`instantly ${what}: HTTP ${status}${message ? ` ${message}` : ""}`);
    this.name = "InstantlyError";
    this.status = status;
  }
}

export function instantly(opts: { apiKey: string; http: HttpClient }): InstantlyClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const r = await opts.http.json<T & { message?: string }>(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.apiKey}` },
      ...(body === undefined ? {} : { body }),
    });
    if (!r.ok || r.body === null)
      throw new InstantlyError(`${method} ${safeUrl(`${API}${path}`)}`, r.status, r.body?.message);
    return r.body;
  }
  return {
    async account(email) {
      try {
        const a = await call<{ email: string; status: number; warmup_status: number }>(
          "GET",
          `/accounts/${encodeURIComponent(email)}`,
        );
        return { email: a.email, status: a.status, warmupStatus: a.warmup_status };
      } catch (err) {
        if (err instanceof InstantlyError && err.status === 404) return null;
        throw err;
      }
    },
    async oauthInit() {
      const r = await call<{ session_id: string; auth_url: string }>(
        "POST",
        "/oauth/google/init",
        {},
      );
      return { sessionId: r.session_id, authUrl: r.auth_url };
    },
    async oauthStatus(sessionId) {
      const r = await call<{
        status: OauthStatus["status"];
        email?: string;
        error?: string;
        error_description?: string;
      }>("GET", `/oauth/session/status/${encodeURIComponent(sessionId)}`);
      if (r.status === "success") return { status: "success", email: r.email ?? "" };
      if (r.status === "error")
        return {
          status: "error",
          error: r.error ?? "unknown",
          description: r.error_description ?? "",
        };
      return { status: r.status === "expired" ? "expired" : "pending" };
    },
    async enableWarmup(emails) {
      const r = await call<{ id: string }>("POST", "/accounts/warmup/enable", { emails });
      return r.id;
    },
    async job(id) {
      const r = await call<{ status: string }>("GET", `/background-jobs/${encodeURIComponent(id)}`);
      return r.status;
    },
  };
}
