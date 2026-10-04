/**
 * Dynadot (API3, JSON): the registrar for cold-email domains. Cloudflare's
 * registrar cannot move a domain's name servers; Dynadot can, and
 * Inbox Insiders writes mailbox DNS into a Dynadot account directly.
 * `register` spends the account's prepaid balance, never a card. The key
 * rides in the query (Dynadot has no header auth); errors name the path
 * only (`safeUrl`). Regular accounts get one thread, 60 calls a minute.
 */
import { type HttpClient, safeUrl } from "./http.js";

const API = "https://api.dynadot.com/api3.json";

export interface DomainPrice {
  name: string;
  available: boolean;
  /** USD for the first year; null when taken. */
  price: number | null;
  renewal: number | null;
}

/** One record as Dynadot's DNS holds it; `name` is "@" at the apex. */
export interface DnsRecord {
  name: string;
  type: string;
  value: string;
  /** MX distance. */
  priority?: number;
}

export interface DynadotClient {
  /** Free or not, and the price; one call per domain (Dynadot's rule). */
  search(domain: string): Promise<DomainPrice>;
  /** Whether this account holds the domain. */
  owned(domain: string): Promise<boolean>;
  /** USD on the account; registrations draw from it. */
  balance(): Promise<number>;
  /** Buys one year from the balance. */
  register(domain: string): Promise<void>;
  nameservers(domain: string): Promise<string[]>;
  setNameservers(domain: string, ns: string[]): Promise<void>;
  /** The records on Dynadot's own DNS; empty when the domain points elsewhere. */
  records(domain: string): Promise<DnsRecord[]>;
}

export class DynadotError extends Error {
  constructor(command: string, message: string) {
    super(`dynadot ${command}: ${message}`);
    this.name = "DynadotError";
  }
}

type Answer = { ResponseCode?: string | number; SuccessCode?: string | number; Error?: string };

export function dynadot(opts: { apiKey: string; http: HttpClient }): DynadotClient {
  async function call<T>(command: string, params: Record<string, string> = {}): Promise<T> {
    const q = new URLSearchParams({ key: opts.apiKey, command, ...params });
    const r = await opts.http.json<Record<string, T & Answer>>(`${API}?${q}`);
    const body = r.body ? Object.values(r.body)[0] : undefined;
    if (!r.ok || !body) throw new DynadotError(command, `HTTP ${r.status} at ${safeUrl(API)}`);
    const code = Number(body.ResponseCode ?? body.SuccessCode ?? -1);
    if (code !== 0) throw new DynadotError(command, body.Error ?? `code ${code}`);
    return body;
  }
  const usd = (text: string | undefined, label: string) => {
    const m = text?.match(new RegExp(`${label} price: ([\\d.]+) in USD`, "i"));
    return m ? Number(m[1]) : null;
  };
  return {
    async search(domain) {
      const r = await call<{ SearchResults?: { Available?: string; Price?: string }[] }>("search", {
        domain0: domain,
        show_price: "1",
        currency: "USD",
      });
      const hit = r.SearchResults?.[0];
      if (!hit) throw new DynadotError("search", `no answer for ${domain}`);
      const available = hit.Available === "yes";
      return {
        name: domain,
        available,
        price: available ? usd(hit.Price, "Registration") : null,
        renewal: available ? usd(hit.Price, "Renewal") : null,
      };
    },
    async owned(domain) {
      try {
        await call("domain_info", { domain });
        return true;
      } catch (err) {
        if (err instanceof DynadotError && /could not find domain/i.test(err.message)) return false;
        throw err;
      }
    },
    async balance() {
      try {
        const r = await call<{ BalanceList?: { Currency: string; Amount: string }[] }>(
          "get_account_balance",
        );
        const row = r.BalanceList?.find((b) => b.Currency === "USD");
        return row ? Number(row.Amount.replace(/,/g, "")) : 0;
      } catch (err) {
        // An account that never deposited answers with an error, not a zero.
        if (err instanceof DynadotError && /no balance/i.test(err.message)) return 0;
        throw err;
      }
    },
    async register(domain) {
      await call("register", { domain, duration: "1", currency: "USD" });
    },
    async nameservers(domain) {
      const r = await call<{ NsContent?: Record<string, string> }>("get_ns", { domain });
      return Object.entries(r.NsContent ?? {})
        .filter(([k, v]) => /^Host\d*$/.test(k) && v)
        .map(([, v]) => v.toLowerCase().replace(/\.$/, ""));
    },
    async setNameservers(domain, ns) {
      await call("set_ns", { domain, ...Object.fromEntries(ns.map((n, i) => [`ns${i}`, n])) });
    },
    async records(domain) {
      const r = await call<unknown>("get_dns", { domain });
      return dnsRecordsIn(r);
    },
  };
}

/**
 * Every record in a get_dns answer. Dynadot documents only the parking
 * shape, so this walks the tree for anything with a record type: apex rows
 * have no subhost, sub rows do. ponytail: shape inferred, the fleet's
 * isolate step refuses to move name servers unless MX and SPF came across.
 */
export function dnsRecordsIn(tree: unknown): DnsRecord[] {
  const out: DnsRecord[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    const type = pick(o, ["RecordType", "Type", "record_type"]);
    const value = pick(o, ["Value", "value", "RecordValue"]);
    if (type && value && /^(a|aaaa|cname|mx|txt|caa|srv|ns)$/i.test(type)) {
      const name = pick(o, ["Subhost", "SubHost", "subhost", "Name"]) || "@";
      const prio = pick(o, ["Value2", "Distance", "Priority", "value2"]);
      out.push({
        name,
        type: type.toUpperCase(),
        value,
        ...(type.toLowerCase() === "mx" && prio ? { priority: Number(prio) } : {}),
      });
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(tree);
  return out;
}

function pick(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}
