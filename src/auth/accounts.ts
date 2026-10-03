/**
 * The credentials as a page sees them: which sites have one, what it
 * holds (never the values), and a way to add or change one and prove it
 * with a real sign-in. The CLI's `creds set`/`login` and the UI's
 * Accounts page are the same code.
 */

import { type Credential, type CredentialStore, credentialSchema } from "credvault";
import { z } from "zod";
import { defineFlow, type FlowPage, type FlowRunner } from "../browser/flow.js";
import { credentialFor, resolveLogin, type SiteLogin, viaLogin } from "./login.js";
import { PROVIDERS } from "./providers.js";
import { MAIN, resolveAccount, shownRoles } from "./roles.js";
import { SITE_LOGINS } from "./sites.js";

export interface AccountRow {
  site: string;
  /** The site has a login spec here; false for one stored with `creds via` alone. */
  known: boolean;
  /** What the site's spec asks for, in its own terms. */
  ask: string | null;
  username: string | null;
  via: string | null;
  url: string | null;
  has: {
    password: boolean;
    totpSecret: boolean;
    passkeys: boolean;
    recoveryCodes: boolean;
    codesInbox: boolean;
  };
}

/** What a form sends: every field optional, an empty string means "leave as is". */
export const accountEdit = z.object({
  username: z.string().trim().optional(),
  password: z.string().optional(),
  totpSecret: z.string().trim().optional(),
  via: z.enum(PROVIDERS).or(z.literal("")).optional(),
  url: z.string().trim().optional(),
  codesInbox: z.string().trim().optional(),
});
export type AccountEdit = z.infer<typeof accountEdit>;

export interface Accounts {
  list(): Promise<AccountRow[]>;
  /** Store or change; the sealed store validates (a password or a via provider is required). */
  save(site: string, edit: AccountEdit): Promise<AccountRow>;
  /** Sign in headless with what is stored and say so, or throw why not. */
  check(site: string): Promise<string>;
}

const SITE = /^[a-z][a-z0-9-]*(@[a-z0-9][a-z0-9.@_-]*)?$/i;

export function rowOf(site: string, cred: Credential | null, login: SiteLogin | null): AccountRow {
  return {
    site,
    known: login !== null,
    ask: login?.ask ?? null,
    username: cred?.username ?? null,
    via: cred?.via ?? null,
    url: cred?.url ?? null,
    has: {
      password: Boolean(cred?.password),
      totpSecret: Boolean(cred?.totpSecret),
      passkeys: (cred?.passkeys.length ?? 0) > 0,
      recoveryCodes: (cred?.recoveryCodes.length ?? 0) > 0,
      codesInbox: Boolean(cred?.codesInbox),
    },
  };
}

/** The stored credential with the edit applied: blanks keep what is there, `via: ""` drops the provider. */
export function merged(existing: Credential | null, edit: AccountEdit): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(edit)) {
    if (v === undefined) continue;
    if (v === "") {
      if (k === "via") delete next.via;
      continue;
    }
    next[k] = v;
  }
  return next;
}

export function accountsOf(opts: {
  store: CredentialStore;
  logins: readonly SiteLogin[];
  /** A browser to prove a sign-in with; absent = `check` says so. */
  runner?: FlowRunner;
}): Accounts {
  const { store, logins } = opts;
  const loginOf = async (site: string): Promise<SiteLogin | null> => {
    const known = resolveLogin(logins, site);
    if (known) return known;
    const cred = await store.get(site);
    return cred?.via ? viaLogin(site, cred) : null;
  };
  const row = async (site: string) =>
    rowOf(site, await store.get(site), resolveLogin(logins, site));
  return {
    async list() {
      // Every spec'd site (credential or not, under the spec's own credential name), then the rest of the store.
      const names = new Set<string>();
      for (const l of logins) names.add(l.credential ?? l.site);
      for (const s of await store.list()) names.add(s);
      const rows = await Promise.all([...names].map(row));
      return rows.sort((a, b) => a.site.localeCompare(b.site));
    },
    async save(site, edit) {
      if (!SITE.test(site)) throw new Error(`not a site name: ${site}`);
      const parsed = credentialSchema.safeParse(merged(await store.get(site), edit));
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
      await store.put(site, parsed.data);
      return row(site);
    },
    async check(site) {
      const runner = opts.runner;
      if (!runner) throw new Error("no browser here to sign in with");
      const login = await loginOf(site);
      if (!login)
        throw new Error(
          `unknown site ${site}: no login spec, and no stored credential says via which provider`,
        );
      if (!(await store.get(login.credential ?? site)))
        throw new Error(`no credential for ${login.credential ?? site}`);
      const flow = defineFlow<undefined, string>({
        site,
        name: "login",
        async run(fp: FlowPage) {
          if (!login.home) return fp.human(`no home page known for ${site}: set its login URL`);
          await fp.open(login.home); // a wall here is what triggers the sign-in
          if (await login.loggedIn(fp)) return "signed in";
          return fp.human("not signed in after opening the home page");
        },
      });
      return runner.run(flow, undefined);
    },
  };
}

/** `instagram@wren` → `instagram`: the platform a credential name is on. */
export const platformOf = (name: string): string => name.split("@")[0] ?? name;

/** Where a site's accounts are stored: `gmail`, `drive` → `google` (an app of it); else itself. */
const storedOn = (site: string): string => platformOf(credentialFor(SITE_LOGINS, platformOf(site)));

/** One stored account on a platform: who it is, what it is for, how it signs in. */
export interface PlatformAccount {
  /** The stored key (`x@wren`); a person names the account by role or username instead. */
  name: string;
  username: string;
  roles: string[];
  how: string;
}

/** Every credential on `platform` (`x`, `x@wren`, …), or on every platform when none is given; canaries left out. */
export async function accountsOn(
  store: CredentialStore,
  platform?: string,
): Promise<PlatformAccount[]> {
  const names = (await store.list())
    .filter((n) => !platform || platformOf(n) === storedOn(platform))
    .sort((a, b) => platformOf(a).localeCompare(platformOf(b)) || a.localeCompare(b));
  const out: PlatformAccount[] = [];
  for (const name of names) {
    const c = await store.get(name);
    if (!c || c.canary) continue;
    out.push({
      name,
      username: c.username || "(no username)",
      roles: c.roles ?? [],
      // Every way in, in the order tried (`methodsOf`).
      how:
        [
          c.password && (c.totpSecret ? "password+totp" : "password"),
          c.via && `via ${c.via}`,
          c.passkeys.length > 0 && "passkey",
        ]
          .filter(Boolean)
          .join(", then ") || "no way in stored",
    });
  }
  // Roles as a person reads them (`x@wren` answers to `wren`); main first, then by role.
  const count = new Map<string, number>();
  for (const r of out) count.set(platformOf(r.name), (count.get(platformOf(r.name)) ?? 0) + 1);
  for (const r of out)
    r.roles = shownRoles(
      { key: r.name, username: r.username, roles: r.roles },
      count.get(platformOf(r.name)) ?? 1,
    );
  const rank = (r: PlatformAccount) => (r.roles.includes(MAIN) ? 0 : r.roles.length ? 1 : 2);
  return out.sort(
    (a, b) =>
      platformOf(a.name).localeCompare(platformOf(b.name)) ||
      rank(a) - rank(b) ||
      (a.roles[0] ?? a.username).localeCompare(b.roles[0] ?? b.username),
  );
}

/**
 * The stored key, when no name a person would type reaches it: not the
 * bare site (main or only), not `site@<role>`, not `site@<username>`.
 */
const oddKey = (r: PlatformAccount): string | null => {
  const site = platformOf(r.name);
  const label = r.name.slice(site.length + 1).toLowerCase();
  if (!label || r.roles.includes(label) || label === r.username.toLowerCase()) return null;
  return r.name;
};

/**
 * Accounts grouped under their platform: the username first, then its
 * roles, then how it signs in. What `creds list` prints.
 *
 *   x
 *     me@gmail.com     main, personal  password
 *     wren_automation  wren            password
 */
export function formatAccounts(rows: readonly PlatformAccount[]): string {
  const roles = (r: PlatformAccount) => r.roles.join(", ");
  const u = Math.max(0, ...rows.map((r) => r.username.length));
  const w = Math.max(0, ...rows.map((r) => roles(r).length));
  const lines: string[] = [];
  let last = "";
  for (const r of rows) {
    const p = platformOf(r.name);
    if (p !== last) lines.push(p);
    last = p;
    const odd = oddKey(r);
    lines.push(
      `  ${r.username.padEnd(u)}  ${roles(r).padEnd(w)}  ${r.how}${odd ? `  (stored as ${odd})` : ""}`.trimEnd(),
    );
  }
  return lines.join("\n");
}

/**
 * The one account `which` names on a platform: a role (`wren`), a stored key
 * (`x@wren`), its username, or a unique part of the username. `site@x`
 * given: the account that name means (`namedStore`). The bare site: its
 * main account, or its only one. Several and nothing to choose by, or no
 * match: an error listing them, so the caller picks.
 */
export async function pickAccount(
  store: CredentialStore,
  site: string,
  which?: string,
): Promise<string> {
  const all = await accountsOn(store, site);
  const held = all.map((a) => ({ key: a.name, username: a.username, roles: a.roles }));
  const named = (n: string) => resolveAccount(held, n);
  if (!which) {
    const name = site.includes("@") ? credentialFor(SITE_LOGINS, site) : storedOn(site);
    const hit = named(name);
    if (hit) return hit;
    throw new Error(
      site.includes("@")
        ? `no account ${name}${listed(all)}`
        : all.length
          ? `${all.length} accounts on ${site}, none main; name one (role or username)${listed(all)}`
          : `no credential stored for ${site}`,
    );
  }
  const w = which.toLowerCase();
  const exact = named(`${storedOn(site)}@${w}`);
  if (exact) return exact;
  const tiers: ((a: PlatformAccount) => boolean)[] = [
    (a) => a.name === which,
    (a) => a.username.toLowerCase().split("@")[0] === w,
    (a) => a.username.toLowerCase().includes(w),
  ];
  for (const t of tiers) {
    const hit = all.filter(t);
    if (hit.length === 1 && hit[0]) return hit[0].name;
    if (hit.length > 1) throw new Error(`${which} matches ${hit.length} accounts${listed(hit)}`);
  }
  throw new Error(`no account ${which} on ${platformOf(site)}${listed(all)}`);
}

const listed = (rows: readonly PlatformAccount[]) =>
  rows.length ? `:\n${formatAccounts(rows)}` : "";
