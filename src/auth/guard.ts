/**
 * Where a secret may go. A credential's password is typed only on its own
 * site's origins (instagram's never lands on a page that merely looks like
 * Instagram), and every use, allowed or refused, is a line in the audit
 * ledger: which credential, which field, which site, which page, by whom.
 * Values are never written anywhere here.
 */
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FlowPage, Op } from "../browser/flow.js";
import type { Credential } from "./credentials.js";

export interface SecretUse {
  at: string;
  /** The credential's store name (`google`, `google@will`). */
  credential: string;
  field: "password" | "previousPassword" | "secret";
  /** The site the session is on (the profile). */
  site: string;
  /** The page, without its query (tokens ride in queries). */
  url: string;
  /** Who used it: `login`, `place`, a flow name. */
  by: string;
  allowed: boolean;
}

export interface SecretAudit {
  record(use: SecretUse): Promise<void>;
  /** Newest last. */
  recent(n?: number): Promise<SecretUse[]>;
}

/** JSON lines, owner-only, appended. */
export function fileAudit(path: string): SecretAudit {
  let ready: Promise<void> | null = null;
  const ensure = () =>
    (ready ??= (async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, "", { mode: 0o600 });
      await chmod(path, 0o600);
    })());
  return {
    async record(use) {
      await ensure();
      await appendFile(path, `${JSON.stringify(use)}\n`, { mode: 0o600 });
    },
    async recent(n = 50) {
      const text = await readFile(path, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .slice(-n)
        .map((l) => JSON.parse(l) as SecretUse);
    },
  };
}

export function memoryAudit(): SecretAudit & { uses: SecretUse[] } {
  const uses: SecretUse[] = [];
  return {
    uses,
    async record(u) {
      uses.push(u);
    },
    async recent(n = 50) {
      return uses.slice(-n);
    },
  };
}

export class SecretLeak extends Error {
  constructor(
    readonly credential: string,
    readonly host: string,
  ) {
    super(`${credential}'s password is not typed on ${host}: not one of its origins`);
    this.name = "SecretLeak";
  }
}

/** `host` is `domain` or under it. */
export function hostUnder(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** The registrable part of a host, two labels (`www.instagram.com` → `instagram.com`); a naive cut, enough for the sites here. */
export function registrable(host: string): string {
  const parts = host.toLowerCase().split(".");
  return parts.slice(-2).join(".");
}

export function urlWithoutQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

export interface GuardOptions {
  /** The credential's store name. */
  name: string;
  cred: Credential;
  /** Origins its password may be typed on, as registrable domains or full hosts. */
  domains: readonly string[];
  site: string;
  by: string;
  audit?: SecretAudit;
  /** With no domains known: a host that carries this word is allowed (`instantly` → app.instantly.ai). */
  fallback?: string;
}

/**
 * The page with the credential's password bound to its origins: a `fill`
 * whose value is the password (or the previous one) on any other host is
 * refused with `SecretLeak` before anything is typed, and every such fill
 * is recorded. Other acts pass through untouched.
 */
export function guardedPage(fp: FlowPage, g: GuardOptions): FlowPage {
  const secrets: [SecretUse["field"], string | undefined][] = [
    ["password", g.cred.password],
    ["previousPassword", g.cred.previousPassword],
  ];
  const fieldOf = (op: Op): SecretUse["field"] | null => {
    if (op.kind !== "fill") return null;
    return secrets.find(([, v]) => v && v === op.value)?.[0] ?? null;
  };
  return {
    ...fp,
    async act(op, hints, opts) {
      const field = fieldOf(op);
      if (field) {
        const url = fp.url();
        const host = (() => {
          try {
            return new URL(url).host;
          } catch {
            return "";
          }
        })();
        const allowed = g.domains.length
          ? g.domains.some((d) => hostUnder(host, d))
          : Boolean(g.fallback && host.toLowerCase().includes(g.fallback.toLowerCase()));
        await g.audit?.record({
          at: new Date().toISOString(),
          credential: g.name,
          field,
          site: g.site,
          url: urlWithoutQuery(url),
          by: g.by,
          allowed,
        });
        if (!allowed) throw new SecretLeak(g.name, host || "(no page)");
      }
      return fp.act(op, hints, opts);
    },
  };
}
