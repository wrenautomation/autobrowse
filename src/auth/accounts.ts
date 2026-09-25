/**
 * The credentials as a page sees them: which sites have one, what it
 * holds (never the values), and a way to add or change one and prove it
 * with a real sign-in. The CLI's `creds set`/`login` and the UI's
 * Accounts page are the same code.
 */

import { type Credential, type CredentialStore, credentialSchema } from "credvault";
import { z } from "zod";
import { defineFlow, type FlowPage, type FlowRunner } from "../browser/flow.js";
import { resolveLogin, type SiteLogin, viaLogin } from "./login.js";
import { PROVIDERS } from "./providers.js";

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

/** One stored account on a platform: its credential name and whose it is. */
export interface PlatformAccount {
  name: string;
  username: string;
  how: string;
}

/** Every credential on `platform` (`x`, `x@wren`, …), or on every platform when none is given; canaries left out. */
export async function accountsOn(
  store: CredentialStore,
  platform?: string,
): Promise<PlatformAccount[]> {
  const names = (await store.list())
    .filter((n) => !platform || platformOf(n) === platformOf(platform))
    .sort((a, b) => platformOf(a).localeCompare(platformOf(b)) || a.localeCompare(b));
  const out: PlatformAccount[] = [];
  for (const name of names) {
    const c = await store.get(name);
    if (!c || c.canary) continue;
    out.push({
      name,
      username: c.username || "(no username)",
      how: c.via ? `via ${c.via}` : c.totpSecret ? "totp" : "password",
    });
  }
  return out;
}

/** Accounts grouped under their platform, usernames whole: what `creds list` prints. */
export function formatAccounts(rows: readonly PlatformAccount[]): string {
  const w = Math.max(0, ...rows.map((r) => r.name.length));
  const u = Math.max(0, ...rows.map((r) => r.username.length));
  const lines: string[] = [];
  let last = "";
  for (const r of rows) {
    const p = platformOf(r.name);
    if (p !== last) lines.push(p);
    last = p;
    lines.push(`  ${r.name.padEnd(w)}  ${r.username.padEnd(u)}  ${r.how}`);
  }
  return lines.join("\n");
}

/**
 * The one account `which` names on a platform: its credential name
 * (`x@wren`), its label (`wren`), its username, or a unique part of the
 * username. `site@label` given: that. Several and nothing to choose by, or
 * no match: an error listing them, so the caller picks.
 */
export async function pickAccount(
  store: CredentialStore,
  site: string,
  which?: string,
): Promise<string> {
  const all = await accountsOn(store, site);
  if (site.includes("@") && !which) {
    if (all.some((a) => a.name === site)) return site;
    throw new Error(`no credential ${site}${listed(all)}`);
  }
  if (!which) {
    const only = all.length === 1 ? all[0] : undefined;
    if (only) return only.name;
    throw new Error(
      all.length
        ? `${all.length} accounts on ${site}; name one (label or username)${listed(all)}`
        : `no credential stored for ${site}`,
    );
  }
  const w = which.toLowerCase();
  const tiers: ((a: PlatformAccount) => boolean)[] = [
    (a) => a.name === which || a.name === `${platformOf(site)}@${w}`,
    (a) => a.username.toLowerCase() === w,
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
