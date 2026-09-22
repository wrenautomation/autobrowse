/**
 * Where a secret may go. A credential's password is typed only on its own
 * site's origins (instagram's never lands on a page that merely looks like
 * Instagram), and every use, allowed or refused, is a line in the audit
 * ledger: which credential, which field, which site, which page, by whom.
 * Values are never written anywhere here.
 */
import type { BrowserFlow, FlowPage, FlowRunner } from "../browser/flow.js";
import { chainedFile } from "../deps/chain.js";
import type { SecretSource } from "../deps/secrets.js";
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
/** The file ledger is hash-chained (`deps/chain.ts`): `ledger verify` finds any edit. */
export function fileAudit(path: string): SecretAudit {
  const file = chainedFile<SecretUse>(path);
  return {
    async record(use) {
      await file.append(use);
    },
    recent: (n = 50) => file.recent(n),
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
    what = "password",
  ) {
    super(`${credential}'s ${what} is not typed on ${host}: not one of its origins`);
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

/** A typed value that is a secret: which one, and which field of it. */
export interface SecretMatch {
  credential: string;
  field: SecretUse["field"];
}

export interface BindOptions {
  /** The secret a fill's value is, or null for an ordinary value. */
  secretOf: (value: string) => SecretMatch | null;
  /** May this secret be typed on this host? */
  allow: (host: string, match: SecretMatch) => boolean;
  site: string;
  by: string;
  audit?: SecretAudit | undefined;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * The page with secrets bound to hosts: a `fill` whose value is a secret is
 * checked against the page's host before anything is typed, recorded
 * either way, and refused with `SecretLeak` when the host is not allowed.
 * Other acts pass through untouched.
 */
export function boundPage(fp: FlowPage, b: BindOptions): FlowPage {
  return {
    ...fp,
    async act(op, hints, opts) {
      const match = op.kind === "fill" ? b.secretOf(op.value) : null;
      if (match) {
        const url = fp.url();
        const host = hostOf(url);
        const allowed = b.allow(host, match);
        await b.audit?.record({
          at: new Date().toISOString(),
          credential: match.credential,
          field: match.field,
          site: b.site,
          url: urlWithoutQuery(url),
          by: b.by,
          allowed,
        });
        if (!allowed)
          throw new SecretLeak(
            match.credential,
            host || "(no page)",
            match.field === "secret" ? "value" : "password",
          );
      }
      return fp.act(op, hints, opts);
    },
  };
}

/**
 * The page with the credential's password bound to its origins: the
 * password (or the previous one) is typed only on `domains`, or, with
 * none known, on a host carrying the site's word.
 */
export function guardedPage(fp: FlowPage, g: GuardOptions): FlowPage {
  const secrets: [SecretUse["field"], string | undefined][] = [
    ["password", g.cred.password],
    ["previousPassword", g.cred.previousPassword],
  ];
  return boundPage(fp, {
    secretOf: (value) => {
      const field = secrets.find(([, v]) => v && v === value)?.[0];
      return field ? { credential: g.name, field } : null;
    },
    allow: (host) =>
      g.cred.canary !== true &&
      (g.domains.length
        ? g.domains.some((d) => hostUnder(host, d))
        : Boolean(g.fallback && host.toLowerCase().includes(g.fallback.toLowerCase()))),
    site: g.site,
    by: g.by,
    audit: g.audit,
  });
}

/** A secret source that remembers what it handed out, so a page can tell a secret's value from any other. */
export interface TrackingSecrets extends SecretSource {
  /** The key a value was handed out under, or null. */
  keyOf(value: string): string | null;
}

export function trackingSecrets(source: SecretSource): TrackingSecrets {
  const keys = new Map<string, string>();
  return {
    async get(key) {
      const value = await source.get(key);
      keys.set(value, key);
      return value;
    },
    keyOf: (value) => keys.get(value) ?? null,
  };
}

export interface BoundRunnerOptions {
  secrets: TrackingSecrets;
  /** May a secret be typed on this host while running a flow of `site`? */
  allow: (site: string, host: string) => boolean;
  audit?: SecretAudit | undefined;
}

/**
 * A runner whose flows see a bound page: any secret a compiled workflow
 * fetched from `secrets` is typed only where `allow(site, host)` says,
 * and every such fill is a line in the audit ledger under the flow's name.
 */
export function boundRunner(runner: FlowRunner, o: BoundRunnerOptions): FlowRunner {
  return {
    run<I, O>(flow: BrowserFlow<I, O>, input: I): Promise<O> {
      const bound: BrowserFlow<I, O> = {
        ...flow,
        run: (fp, i) =>
          flow.run(
            boundPage(fp, {
              secretOf: (value) => {
                const key = o.secrets.keyOf(value);
                return key ? { credential: key, field: "secret" } : null;
              },
              allow: (host) => o.allow(flow.site, host),
              site: flow.site,
              by: `${flow.site}/${flow.name}`,
              audit: o.audit,
            }),
            i,
          ),
      };
      return runner.run(bound, input);
    },
  };
}
