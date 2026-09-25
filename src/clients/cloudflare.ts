/**
 * Cloudflare: registrar of record and authoritative DNS for every fleet
 * domain. Zones, records, and (Registrar API, beta since 2026-04) the
 * price check and the purchase itself, at cost.
 */
import { type HttpClient, safeUrl } from "./http.js";

const API = "https://api.cloudflare.com/client/v4";

export interface DnsRecord {
  type: "MX" | "TXT" | "CNAME" | "A";
  /** Relative to the zone: "@", "_dmarc", "google._domainkey". */
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
}

/** What Cloudflare would charge for a domain, from its registry check. Costs are USD strings ("8.50"). */
export interface DomainQuote {
  name: string;
  registrable: boolean;
  /** Why not, when not: `domain_unavailable`, an unsupported extension, … */
  reason?: string;
  price?: string;
  renewal?: string;
}

/** A registration's state: `in_progress` until `succeeded`, `failed`, `action_required` or `blocked`. */
export interface Registration {
  state: string;
  completed: boolean;
}

export interface CloudflareClient {
  /** Registry-fresh availability and price, 20 names a request. */
  check(domains: string[]): Promise<DomainQuote[]>;
  /** Buy it at cost (WHOIS redaction on). Irreversible: charges the account's default card. */
  register(domain: string): Promise<Registration>;
  /** The registration started for this domain, or null when none was. */
  registration(domain: string): Promise<Registration | null>;
  /** The zone id, or null when Cloudflare does not host the domain. */
  zoneId(domain: string): Promise<string | null>;
  /** Registered in this account (through Cloudflare Registrar)? */
  registered(domain: string): Promise<boolean>;
  /** Create the zone; returns its id. */
  createZone(domain: string): Promise<string>;
  /** Idempotent: same type+name+content is left alone; a differing record of the same type+name is replaced when `replace`. */
  upsertRecord(
    zoneId: string,
    record: DnsRecord,
    opts?: { replace?: boolean },
  ): Promise<"created" | "kept" | "replaced">;
  listRecords(
    zoneId: string,
    type?: DnsRecord["type"],
    name?: string,
  ): Promise<Array<DnsRecord & { id: string }>>;
}

type Envelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
};

export class CloudflareError extends Error {
  readonly status: number;
  constructor(what: string, status: number, errors: Array<{ code: number; message: string }> = []) {
    super(
      `cloudflare ${what}: HTTP ${status} ${errors.map((e) => `${e.code} ${e.message}`).join("; ")}`,
    );
    this.name = "CloudflareError";
    this.status = status;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `GET /user/tokens/verify` with the candidate token: active or not. Never throws on a bad token. */
export async function verifyCloudflareToken(http: HttpClient, token: string): Promise<boolean> {
  const r = await http.json<{ success?: boolean; result?: { status?: string } }>(
    `${API}/user/tokens/verify`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return r.ok && r.body?.success === true && r.body.result?.status === "active";
}

export function cloudflare(opts: {
  apiToken: string;
  accountId: string;
  http: HttpClient;
}): CloudflareClient {
  async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const r = await opts.http.json<Envelope<T>>(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.apiToken}` },
      ...(body === undefined ? {} : { body }),
    });
    if (!r.ok || !r.body?.success)
      throw new CloudflareError(`${method} ${safeUrl(`${API}${path}`)}`, r.status, r.body?.errors);
    return r.body.result;
  }
  const fqdn = (zone: string, name: string) => (name === "@" ? zone : `${name}.${zone}`);
  // A zone's name never changes; one lookup per zone id per process, not per record.
  const zoneNames = new Map<string, string>();
  const zoneName = async (zoneId: string): Promise<string> => {
    const known = zoneNames.get(zoneId);
    if (known) return known;
    const zone = await call<{ name: string }>("GET", `/zones/${zoneId}`);
    zoneNames.set(zoneId, zone.name);
    return zone.name;
  };

  return {
    async zoneId(domain) {
      const zones = await call<Array<{ id: string; name: string }>>(
        "GET",
        `/zones?name=${encodeURIComponent(domain)}`,
      );
      return zones.find((z) => z.name === domain)?.id ?? null;
    },
    async check(domains) {
      const out: DomainQuote[] = [];
      for (let i = 0; i < domains.length; i += 20) {
        const r = await call<{
          domains: Array<{
            name: string;
            registrable: boolean;
            reason?: string;
            pricing?: { registration_cost?: string; renewal_cost?: string };
          }>;
        }>("POST", `/accounts/${opts.accountId}/registrar/domain-check`, {
          domains: domains.slice(i, i + 20),
        });
        for (const d of r.domains)
          out.push({
            name: d.name,
            registrable: d.registrable,
            ...(d.reason ? { reason: d.reason } : {}),
            ...(d.pricing?.registration_cost ? { price: d.pricing.registration_cost } : {}),
            ...(d.pricing?.renewal_cost ? { renewal: d.pricing.renewal_cost } : {}),
          });
      }
      return out;
    },
    async register(domain) {
      const r = await call<Registration>(
        "POST",
        `/accounts/${opts.accountId}/registrar/registrations`,
        {
          domain_name: domain,
        },
      );
      return { state: r.state, completed: r.completed };
    },
    async registration(domain) {
      try {
        const r = await call<Registration>(
          "GET",
          `/accounts/${opts.accountId}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`,
        );
        return { state: r.state, completed: r.completed };
      } catch (err) {
        if (err instanceof CloudflareError && err.status === 404) return null;
        throw err;
      }
    },
    async registered(domain) {
      try {
        const d = await call<{ name: string }>(
          "GET",
          `/accounts/${opts.accountId}/registrar/domains/${encodeURIComponent(domain)}`,
        );
        return d.name === domain;
      } catch (err) {
        if (err instanceof CloudflareError && err.status === 404) return false;
        throw err;
      }
    },
    async createZone(domain) {
      const zone = await call<{ id: string }>("POST", "/zones", {
        name: domain,
        account: { id: opts.accountId },
        type: "full",
      });
      return zone.id;
    },
    async listRecords(zoneId, type, name) {
      const zone = { name: await zoneName(zoneId) };
      const q = new URLSearchParams();
      if (type) q.set("type", type);
      if (name) q.set("name", fqdn(zone.name, name));
      q.set("per_page", "100");
      const rows = await call<
        Array<{
          id: string;
          type: DnsRecord["type"];
          name: string;
          content: string;
          priority?: number;
          ttl: number;
        }>
      >("GET", `/zones/${zoneId}/dns_records?${q.toString()}`);
      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name === zone.name ? "@" : r.name.slice(0, -(zone.name.length + 1)),
        content: r.content,
        ...(r.priority === undefined ? {} : { priority: r.priority }),
        ttl: r.ttl,
      }));
    },
    async upsertRecord(zoneId, record, o = {}) {
      const zone = { name: await zoneName(zoneId) };
      const existing = await this.listRecords(zoneId, record.type, record.name);
      const same = existing.find((r) => normalize(r.content) === normalize(record.content));
      if (same) return "kept";
      const body = {
        type: record.type,
        name: fqdn(zone.name, record.name),
        content: record.content,
        ttl: record.ttl ?? 1,
        ...(record.priority === undefined ? {} : { priority: record.priority }),
      };
      // TXT and MX may legitimately hold several records under one name; only replace when asked.
      const victim = o.replace ? existing[0] : undefined;
      if (victim) {
        await call("PUT", `/zones/${zoneId}/dns_records/${victim.id}`, body);
        return "replaced";
      }
      await call("POST", `/zones/${zoneId}/dns_records`, body);
      return "created";
    },
  };
}

/** TXT content compares without the quotes Cloudflare may add. */
function normalize(content: string): string {
  return content.replace(/^"|"$/g, "").trim().toLowerCase();
}
