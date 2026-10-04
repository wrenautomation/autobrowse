/**
 * Inbox Insiders (API v1): mailboxes on our own Dynadot domains, uploaded
 * to Instantly by them. `order` charges the saved card the moment it
 * lands ($3.50 a mailbox a month, three per domain): only the fleet's
 * gated order step calls it, always with an idempotency key, and a retry
 * after a 402 or a timeout reuses that key. SMTP orders run on their own
 * and answer a run id; Google orders go to their team (no run id).
 * 60 calls a minute per key.
 */
import { type HttpClient, safeUrl } from "./http.js";

const API = "https://inboxinsiders.io/api/v1";

/** Blocklist verdict: major = an authoritative list, minor = advisory only. */
export type BlacklistStatus = "flagged_major" | "flagged_minor" | "clean" | "unknown";

export interface OrderRequest {
  mode: "full_control";
  infrastructure_type: "private_smtp" | "google_workspace";
  domains: string[];
  /** First and last name. */
  sender_name: string;
  website_url: string;
  brand_name?: string;
  domain_registrar: "dynadot";
  dynadot_api_key: string;
  cold_email?: { provider: "instantly"; api_key: string };
  idempotency_key: string;
}

export interface OrderAnswer {
  /** Present on SMTP orders they fulfil by machine. */
  run_id?: string;
  order_id?: string;
  status?: string;
  /** false: their team sets it up (every Google order). */
  instant?: boolean;
  /** true: this key placed an order before; nothing new was charged. */
  duplicate?: boolean;
}

/** A mailbox as the export hands it; passwords are plaintext. */
export interface Mailbox {
  email: string;
  [field: string]: unknown;
}

export interface InboxInsidersClient {
  /** Which names are free to register (50 a call). */
  check(domains: string[]): Promise<{ domain: string; available: boolean }[]>;
  /** Each domain against ten DNS blocklists (25 a call; cached 15 min). */
  blacklist(
    domains: string[],
  ): Promise<{ domain: string; status: BlacklistStatus; listedOn: string[] }[]>;
  /** Charges the card. */
  order(req: OrderRequest): Promise<OrderAnswer>;
  /** An SMTP run's state: completed, completed_with_warnings, failed, or in progress. */
  run(runId: string): Promise<{ status: string; [field: string]: unknown }>;
  /** A finished SMTP run's mailboxes with their SMTP and IMAP logins. */
  export(runId: string): Promise<Mailbox[]>;
}

export class InboxInsidersError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(what: string, status: number, code: string, message: string) {
    super(`inbox insiders ${what}: HTTP ${status} ${code} ${message}`.trim());
    this.name = "InboxInsidersError";
    this.status = status;
    this.code = code;
  }
}

export function inboxInsiders(opts: { apiKey: string; http: HttpClient }): InboxInsidersClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const r = await opts.http.json<T & { error?: { code?: string; message?: string } }>(
      `${API}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${opts.apiKey}` },
        ...(body === undefined ? {} : { body }),
      },
    );
    if (!r.ok || r.body === null)
      throw new InboxInsidersError(
        `${method} ${safeUrl(`${API}${path}`)}`,
        r.status,
        r.body?.error?.code ?? "",
        r.body?.error?.message ?? "",
      );
    return r.body;
  }
  const rows = (body: unknown): Record<string, unknown>[] => {
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    const o = (body ?? {}) as Record<string, unknown>;
    const list = o.results ?? o.domains ?? o.mailboxes ?? o.data;
    return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  };
  return {
    async check(domains) {
      const body = await call<unknown>("POST", "/domains/check", { domains });
      return rows(body).map((r) => ({
        domain: String(r.domain ?? ""),
        available: r.available === true,
      }));
    },
    async blacklist(domains) {
      const body = await call<unknown>("POST", "/domains/blacklist", { domains });
      return rows(body).map((r) => ({
        domain: String(r.domain ?? ""),
        status: (r.status as BlacklistStatus) ?? "unknown",
        listedOn: Array.isArray(r.listed_on)
          ? r.listed_on.map((z) =>
              typeof z === "string" ? z : String((z as { zone?: string }).zone ?? ""),
            )
          : [],
      }));
    },
    order: (req) => call<OrderAnswer>("POST", "/instant-orders", req),
    run: (runId) => call("GET", `/instant-orders?run_id=${encodeURIComponent(runId)}`),
    async export(runId) {
      const body = await call<unknown>(
        "GET",
        `/instant-orders/export?run_id=${encodeURIComponent(runId)}`,
      );
      return rows(body).filter((m): m is Mailbox => typeof m.email === "string");
    },
  };
}
