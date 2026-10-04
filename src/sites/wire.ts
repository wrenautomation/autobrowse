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
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { type HttpClient, httpClient } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import { BROWSER_FLOWS } from "../engine/browser-service.js";
import type { Approver } from "../gates/payment.js";
import type { SpentKeys } from "../reach/key-ring.js";
import type { CompiledCatalog } from "../workflows/compiled.js";
import { runCompiled } from "../workflows/proof.js";
import type { DailyCaps } from "./caps.js";
import { type SiteFacade, siteFacade } from "./facade.js";
import { SITES } from "./index.js";
import { nextLapse, renewals, renewDue, renewWording } from "./renew.js";
import { type SetupStep, type SiteApi, SiteError } from "./types.js";

export interface SiteParts {
  catalog: CompiledCatalog;
  browser: FlowRunner;
  sink: SecretSink;
  oauthPort: number;
  /** The sites served; every built-in one unless said. */
  sites?: readonly SiteApi[];
  /** Where keys and tokens are read from; the process env unless said. */
  env?: (name: string) => string | undefined;
  http?: HttpClient;
  /** Hand-written legs by `site/name`; the built-in catalog unless said. */
  flows?: Record<string, BrowserFlow<never, unknown>>;
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
  /** Paid keys out of credit (Exa's ring); absent: each process remembers its own. */
  spent?: SpentKeys;
}

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
  return byInbox.length === 1 ? (byInbox[0]?.[0] ?? null) : null;
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
    env: (name) => made.get(name) ?? env(name),
    sink: {
      put: async (name, value, o) => {
        await p.sink.put(name, value, o);
        made.set(name, value);
      },
    },
    runner: p.browser,
    flow: (name) => flows[name] ?? null,
    compiled: {
      get: async (name) => (await p.catalog.get(name))?.workflow ?? null,
      run: (workflow, plan, as) =>
        runCompiled(workflow, p.browser, {
          plan,
          sink: p.sink,
          approve: true,
          ...(as ? { as } : {}),
        }),
    },
    oauthPort: p.oauthPort,
    approve: p.approve ?? null,
    ...(p.caps ? { caps: p.caps } : {}),
    ...(p.spent ? { spent: p.spent } : {}),
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
  });
  const reload = p.reload;
  let readAt = 0;
  const call: SiteFacade["call"] = reload
    ? async (...a) => {
        try {
          return await facade.call(...a);
        } catch (e) {
          const miss = e instanceof SiteError && e.status === 501 && /no token/.test(e.message);
          if (!miss || Date.now() - readAt < RELOAD_EVERY_MS) throw e;
          readAt = Date.now();
          const entries = await reload((name) => Boolean(made.get(name) ?? env(name))).catch(
            () => null,
          );
          if (!entries) throw e;
          for (const { name, value } of entries) if (!env(name)) made.set(name, value);
          return facade.call(...a);
        }
      }
    : facade.call;
  const kept = p.kept;
  if (!kept) return { ...facade, call };
  return {
    ...facade,
    call,
    async renew(o = {}) {
      const sites = p.sites ?? SITES;
      const identities = (await p.identities?.()) ?? [];
      const plan = renewals(sites, identities, await kept());
      const results = o.dry ? null : await renewDue(facade, plan);
      return {
        ...plan,
        results: results ?? [],
        lines: renewWording(plan, results),
        next: nextLapse(sites, identities, await kept()),
      };
    },
  };
}
