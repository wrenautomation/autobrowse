/**
 * The site facade from the worker's parts: one instance per process, shared
 * by the HTTP face, the CLI and the `sites` Restate service, so a token a
 * setup step just kept is visible to the next call whichever door it came in.
 * Everything it reads from the process (env, the HTTP client, the catalog of
 * sites and flows) is an option, so a library caller can hand its own.
 */
import type { CredentialStore, EnvEntry, EnvListing } from "credvault";
import {
  DEFAULT_PURPOSE,
  type Identity,
  type IdentityProvider,
  identityAt,
  identityFor,
} from "../auth/identities.js";
import type { DoneActs } from "../browser/attempt.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import type { Render } from "../browser/render.js";
import { type HttpClient, httpClient } from "../clients/http.js";
import type { KeyKeeper } from "../deps/keys.js";
import type { SecretSink } from "../deps/sink.js";
import { BROWSER_FLOWS } from "../engine/browser-service.js";
import type { Approver } from "../gates/payment.js";
import type { SpentKeys } from "../reach/key-ring.js";
import type { KeysDep } from "../reach/key-source.js";
import type { CompiledCatalog } from "../workflows/compiled.js";
import { runCompiled } from "../workflows/proof.js";
import type { DailyCaps } from "./caps.js";
import { checkSite, type SiteFacade, type SiteRow, siteFacade } from "./facade.js";
import { SITES } from "./index.js";
import type { LimitStore } from "./limits.js";
import { type MintedTokens, pointedAt, TokenRefused } from "./oauth.js";
import {
  dueToday,
  GIVE_UP_DAYS,
  maskAccount,
  type RefusedToken,
  type RefusedTokens,
  refusedLine,
} from "./refused.js";
import {
  nextLapse,
  RENEW_WITHIN_MS,
  type RenewResult,
  renewals,
  renewDue,
  renewWording,
} from "./renew.js";
import { type SetupStep, type SiteApi, SiteError } from "./types.js";
import type { UploadSessions } from "./uploads.js";

export interface SiteParts {
  catalog: CompiledCatalog;
  browser: FlowRunner;
  sink: SecretSink;
  /** The owner's key vault, for compiled flows that mint an API key. */
  keeper?: KeyKeeper;
  oauthPort: number;
  /** The sites served; every built-in one unless said. */
  sites?: readonly SiteApi[];
  /** Where keys and tokens are read from; the process env unless said. */
  env?: (name: string) => string | undefined;
  http?: HttpClient;
  /** A page in a stealth browser, for the fetch ladder (`browser/render.ts`); absent: the ladder stops at the TLS rung. */
  render?: Render;
  /** Hand-written legs by `site/name`; the built-in catalog unless said. */
  flows?: Record<string, BrowserFlow<never, unknown>>;
  /** Built walks by catalog name (`fb-public/walk-ad-library`), for a route whose leg is one. */
  walks?: (name: string) => BrowserFlow<never, unknown> | null;
  /**
   * The stored credentials, so a consent for `--account will@x.dev` runs in
   * the `<site>@<label>` profile whose username that is; without them the
   * flow's own profile and its account chooser.
   */
  credentials?: CredentialStore;
  /** Who answers for a route that commits money; absent: such calls are refused. */
  approve?: Approver | null;
  /** The person's accounts and their purposes; a call or consent that names none is for the site's purpose. */
  identities?: () => Promise<Identity[]>;
  /** What the sink holds, with each value's lapse date: turns on `renew`. */
  kept?: () => Promise<EnvListing[]>;
  /**
   * The shared store's entries this process lacks (`have` says which it has):
   * a call that finds no token reads them once and retries, so a token minted
   * on another machine (the laptop) is seen here (the box) without a restart.
   * Only the missing ones: every value read from SSM is a KMS decrypt.
   */
  reload?: (have: (name: string) => boolean) => Promise<EnvEntry[]>;
  /** Per-account daily caps on metered routes (LinkedIn reads); absent: uncapped. */
  caps?: DailyCaps;
  /** The operator's limits over the sites' defaults (`limits.json`); absent: the defaults. */
  limits?: LimitStore;
  /** Paid keys out of credit (Exa's ring); absent: each process remembers its own. */
  spent?: SpentKeys;
  /** The vault's keys, their audit and the call counter (`reach/key-source.ts`); absent: the env names. */
  keys?: KeysDep;
  /** Resumable upload sessions by durable call (`uploads.ts`); absent: a rerun upload starts over. */
  uploads?: UploadSessions;
  /** Irreversible API calls already started, by durable call: a rerun of one is refused. */
  started?: DoneActs;
  /** Tokens the platforms refused (`refused.ts`): turns on keeping them, re-making them, `revoke`. */
  refused?: RefusedTokens;
  /** Access tokens minted by any process on this machine (`fileMintedTokens`). */
  minted?: MintedTokens;
  /** One line to a person (the ops lane); `ping` when it needs them. A failed send fails nothing. */
  notice?: (text: string, o?: { ping?: boolean }) => Promise<void>;
}

/** What our own revoke tells the refused-token rows the site would have said. */
export const REVOKED_WORDS = "revoked by us (site revoke)";

/** How long a store read on a token miss stands before a miss reads again. */
const RELOAD_EVERY_MS = 60_000;

/** Which identity provider a site's consent signs in with: the consent flow's own site (`google/oauth-consent`). */
export function consentProviderOf(s: SiteApi): IdentityProvider | null {
  if (s.via) return s.via;
  const consent = s.setup.find((st) => "oauth" in st.how);
  const spec = consent && "oauth" in consent.how ? consent.how.oauth : null;
  const at = spec && "flow" in spec.consent ? spec.consent.flow.split("/")[0] : null;
  return at === "google" || at === "microsoft" ? at : null;
}

/**
 * The account for a site or step from the person's policy: the one for its
 * purpose at the provider its consent uses. A site with its own logins
 * (LinkedIn, Meta) takes the account for its purpose at any provider, so
 * Wren's work never falls to whoever the site's own credential is (a
 * person's own account, once). Null when no account is set up.
 */
export async function accountForSite(
  identities: readonly Identity[],
  s: SiteApi,
  step?: SetupStep,
): Promise<string | null> {
  return policyAccount(identities, s, step);
}

/** `accountForSite`, for a caller that cannot wait (the `needs` rows). */
export function policyAccount(
  identities: readonly Identity[],
  s: SiteApi,
  step?: SetupStep,
): string | null {
  const at = consentProviderOf(s);
  const purpose = step?.purpose ?? s.purpose ?? DEFAULT_PURPOSE;
  return (
    (at ? identityAt(identities, at, purpose) : identityFor(identities, purpose))?.address ?? null
  );
}

/** The `<site>@<label>` (or `<site>-<label>`) credential name whose username is `account`; the site's own when it matches. */
export async function profileOf(
  credentials: CredentialStore,
  site: string,
  account: string,
): Promise<string | null> {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const own = await credentials.get(site);
  if (own && same(own.username, account)) return site;
  // An inbox that is its own account: `google@will@a.com`.
  const named = `${site}@${account.trim().toLowerCase()}`;
  const byName = await credentials.get(named);
  if (byName && same(byName.username, account)) return named;
  const mine: Array<[string, NonNullable<Awaited<ReturnType<CredentialStore["get"]>>>]> = [];
  for (const name of await credentials.list()) {
    if (!name.startsWith(`${site}@`)) continue;
    const c = await credentials.get(name);
    if (!c) continue;
    if (same(c.username, account)) return name;
    mine.push([name, c]);
  }
  // A handle login (X's `wren_automation`) is the account whose mail it gets: one match only.
  const byInbox = mine.filter(([, c]) => c.codesInbox && same(c.codesInbox, account));
  if (byInbox.length) return byInbox.length === 1 ? (byInbox[0]?.[0] ?? null) : null;
  // the site's own handle login (npm's), when no labeled login claims the inbox
  return own?.codesInbox && same(own.codesInbox, account) ? site : null;
}

/**
 * The username of a credential the caller named as the account: the site's
 * own (`linkedin`) or one of its `site@label` logins. Null for
 * anything else, which is then an address.
 */
export async function usernameOf(
  credentials: CredentialStore,
  site: string,
  name: string,
): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (n !== site && !n.startsWith(`${site}@`)) return null;
  return (await credentials.get(n))?.username ?? null;
}

export function sitesFor(p: SiteParts): SiteFacade {
  // What setup keeps is visible to the next call at once, whichever sink is behind it.
  const made = new Map<string, string>();
  const env = p.env ?? ((name: string) => process.env[name]);
  const flows = p.flows ?? BROWSER_FLOWS;
  const facade = siteFacade(p.sites ?? SITES, {
    http: p.http ?? httpClient(),
    ...(p.render ? { render: p.render } : {}),
    env: (name) => made.get(name) ?? env(name),
    sink: {
      put: async (name, value, o) => {
        // Held first: a rolled refresh token whose store write fails still serves this process.
        made.set(name, value);
        await p.sink.put(name, value, o);
      },
    },
    ...(p.minted ? { minted: p.minted } : {}),
    runner: p.browser,
    flow: (name) => flows[name] ?? p.walks?.(name) ?? null,
    compiled: {
      get: async (name) => (await p.catalog.get(name))?.workflow ?? null,
      run: (workflow, plan, as) =>
        runCompiled(workflow, p.browser, {
          plan,
          sink: p.sink,
          ...(p.keeper ? { keys: p.keeper } : {}),
          approve: true,
          ...(as ? { as } : {}),
        }),
    },
    oauthPort: p.oauthPort,
    approve: p.approve ?? null,
    ...(p.caps ? { caps: p.caps } : {}),
    ...(p.limits ? { limits: p.limits } : {}),
    ...(p.spent ? { spent: p.spent } : {}),
    ...(p.keys ? { keys: p.keys } : {}),
    ...(p.uploads ? { uploads: p.uploads } : {}),
    ...(p.started ? { started: p.started } : {}),
    ...(p.credentials
      ? {
          profileFor: (site, account) => profileOf(p.credentials as CredentialStore, site, account),
          providerOf: consentProviderOf,
          accountOf: (site, name) => usernameOf(p.credentials as CredentialStore, site, name),
        }
      : {}),
    ...(p.identities
      ? {
          accountFor: async (s, step) =>
            accountForSite(await (p.identities as () => Promise<Identity[]>)(), s, step),
        }
      : {}),
    // A token that answers again ends its incident.
    ...(p.refused ? { worked: (name: string) => void p.refused?.clear([name]) } : {}),
  });
  const refused = p.refused;
  const say = async (text: string, o?: { ping?: boolean }) => {
    await p.notice?.(text, o).catch(() => {});
  };
  /** Keep a refusal where `renew` reads it; the first of an incident is said, once. */
  const record = async (e: unknown) => {
    if (!refused || !(e instanceof TokenRefused) || !e.site) return;
    const { fresh, row } = refused.refuse(
      { name: e.token, site: e.site, account: e.account, words: e.why },
      new Date(),
    );
    if (fresh)
      await say(
        `token refused: ${refusedLine(row)}. Renew makes it again (one try a day, ${GIVE_UP_DAYS} days).`,
      );
  };
  const reload = p.reload;
  let readAt = 0;
  /** Another process (the laptop, the desk) may hold what this one lacks: true when a read found it. */
  const reloaded = async (e: unknown): Promise<boolean> => {
    if (!reload) return false;
    // Another process rolled the refresh token: the store holds the new one.
    if (e instanceof TokenRefused) {
      const held = made.get(e.token) ?? env(e.token);
      const entries = await reload((name) => name !== e.token).catch(() => null);
      const fresh = entries?.find((x) => x.name === e.token)?.value;
      if (!fresh || fresh === held) return false;
      made.set(e.token, fresh);
      return true;
    }
    const miss = e instanceof SiteError && e.status === 501 && /no token/.test(e.message);
    if (!miss || Date.now() - readAt < RELOAD_EVERY_MS) return false;
    readAt = Date.now();
    const entries = await reload((name) => Boolean(made.get(name) ?? env(name))).catch(() => null);
    if (!entries) return false;
    for (const { name, value } of entries) if (!env(name)) made.set(name, value);
    return true;
  };
  const call: SiteFacade["call"] = async (...a) => {
    try {
      return await facade.call(...a);
    } catch (e) {
      if (!(await reloaded(e))) {
        await record(e);
        throw e;
      }
    }
    try {
      return await facade.call(...a);
    } catch (e) {
      await record(e);
      throw e;
    }
  };
  // What a setup makes again ends its incident, whichever door ran it.
  const setup: SiteFacade["setup"] = async (...a) => {
    const out = await facade.setup(...a);
    refused?.clear(out.made);
    return out;
  };
  const withRefused = (row: SiteRow): SiteRow => {
    const mine = refused?.list().filter((r) => r.site === row.site) ?? [];
    return mine.length ? { ...row, refused: mine } : row;
  };
  const base = { ...facade, call, setup };
  if (!refused) return withRenew(base);
  return withRenew({
    ...base,
    list: async () => (await facade.list()).map(withRefused),
    status: async (name) => withRefused(await facade.status(name)),
    refused: async () => refused.list(),
    claimRefused: async () => refused.claim(),
    async revoke(site, account) {
      if (!facade.revoke) throw new SiteError(501, "no revoke here");
      const { revoked } = await facade.revoke(site, account).catch(async (e) => {
        await record(e);
        throw e;
      });
      // Every name the grant covered: the real copy, and each alias pointing at it or holding it.
      const real = revoked[0] as string;
      const value = made.get(real) ?? env(real);
      const family = real.split("__")[0] as string;
      const covered = [
        real,
        ...((await p.kept?.()) ?? [])
          .map((e) => e.name)
          .filter((n) => n !== real && (n === family || n.startsWith(`${family}__`)))
          .filter((n) => {
            const held = made.get(n) ?? env(n);
            return pointedAt(held) === real || (value !== undefined && held === value);
          }),
      ];
      const now = new Date();
      for (const name of covered)
        refused.refuse({ name, site, account: account ?? null, words: REVOKED_WORDS }, now);
      await say(`revoked the ${site} grant (${covered.join(", ")}): making it again now`);
      return { revoked: covered };
    },
  });

  /** `renew` when the sink lists what is kept: lapsing tokens and refused ones, made again. */
  function withRenew(f: SiteFacade): SiteFacade {
    const kept = p.kept;
    if (!kept) return f;
    /** One who-am-I call per site with an API leg: a dead token nothing called lately is found. */
    const probeAll = async () => {
      const rows = await facade.list();
      await Promise.all(rows.filter((r) => r.probe).map((r) => checkSite({ call }, r)));
    };
    /** What a person runs once renew has stopped. */
    const howTo = (row: RefusedToken, sites: readonly SiteApi[], identities: Identity[]) => {
      const r = renewals(sites, identities, [], RENEW_WITHIN_MS, 0, [row]).due[0];
      return r
        ? `autobrowse site setup ${r.site} ${r.step}${r.account ? ` (as ${maskAccount(r.account)})` : ""}`
        : `make ${row.name} by hand`;
    };
    const gaveUp = (row: RefusedToken, sites: readonly SiteApi[], identities: Identity[]) =>
      say(
        `token still refused, renew stopped: ${refusedLine(row)}. Run: ${howTo(row, sites, identities)}`,
        { ping: true },
      );
    return {
      ...f,
      async renew(o = {}) {
        const sites = p.sites ?? SITES;
        const identities = (await p.identities?.()) ?? [];
        const now = new Date();
        // A full pass proves each token first; a lone re-make (`names`) and a dry look do not.
        if (!o.dry && !o.names) await probeAll();
        if (!o.dry && refused)
          for (const row of refused.stale(now)) await gaveUp(row, sites, identities);
        const rows = refused
          ? dueToday(refused.list(), now).filter((r) => !o.names || o.names.includes(r.name))
          : [];
        const plan = renewals(
          sites,
          identities,
          o.names ? [] : await kept(),
          RENEW_WITHIN_MS,
          now.getTime(),
          rows,
        );
        let results: RenewResult[] | null = null;
        if (!o.dry) {
          const mine = (n: string) => rows.some((r) => r.name === n);
          results = await renewDue({ setup }, plan, (r) => {
            for (const n of r.names) if (mine(n)) refused?.start(n, now);
          });
          // How each refused name's try went; a name nothing makes is a failed try too.
          const ends: Array<[string, { ok: boolean; error?: string; busy?: boolean }]> = [
            ...results.flatMap((r) =>
              r.names
                .filter(mine)
                .map((n): [string, { ok: boolean; error?: string; busy?: boolean }] => [
                  n,
                  {
                    ok: r.ok,
                    ...(r.error ? { error: r.error } : {}),
                    ...(r.busy ? { busy: true } : {}),
                  },
                ]),
            ),
            ...plan.unplacedRefused.map((n): [string, { ok: boolean; error?: string }] => [
              n,
              { ok: false, error: "no setup step makes it" },
            ]),
          ];
          for (const [n, end] of ends) {
            if (!end.ok) refused?.start(n, now);
            if (!refused?.end(n, end, now).gaveUp) continue;
            const row = refused.list().find((r) => r.name === n);
            if (row) await gaveUp(row, sites, identities);
          }
        }
        return {
          ...plan,
          results: results ?? [],
          lines: renewWording(plan, results),
          next: nextLapse(sites, identities, await kept()),
        };
      },
    };
  }
}
