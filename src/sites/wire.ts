/**
 * The site facade from the worker's parts: one instance per process, shared
 * by the HTTP face, the CLI and the `sites` Restate service, so a token a
 * setup step just kept is visible to the next call whichever door it came in.
 * Everything it reads from the process (env, the HTTP client, the catalog of
 * sites and flows) is an option, so a library caller can hand its own.
 */
import type { CredentialStore } from "../auth/credentials.js";
import {
  DEFAULT_PURPOSE,
  type Identity,
  type IdentityProvider,
  identityAt,
} from "../auth/identities.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { type HttpClient, httpClient } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import { BROWSER_FLOWS } from "../engine/browser-service.js";
import type { Approver } from "../gates/payment.js";
import type { CompiledCatalog } from "../workflows/compiled.js";
import { runCompiled } from "../workflows/proof.js";
import { type SiteFacade, siteFacade } from "./facade.js";
import { SITES } from "./index.js";
import type { SetupStep, SiteApi } from "./types.js";

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
}

/** Which identity provider a site's consent signs in with: the consent flow's own site (`google/oauth-consent`). */
export function consentProviderOf(s: SiteApi): IdentityProvider | null {
  const consent = s.setup.find((st) => "oauth" in st.how);
  const spec = consent && "oauth" in consent.how ? consent.how.oauth : null;
  const at = spec && "flow" in spec.consent ? spec.consent.flow.split("/")[0] : null;
  return at === "google" || at === "microsoft" ? at : null;
}

/**
 * The account for a site or step from the person's policy: the one for its
 * purpose at the provider its consent uses; null for a site whose consent is
 * not an identity provider's (LinkedIn, Meta) or when no account is set up.
 */
export async function accountForSite(
  identities: readonly Identity[],
  s: SiteApi,
  step?: SetupStep,
): Promise<string | null> {
  const at = consentProviderOf(s);
  if (!at) return null;
  return identityAt(identities, at, step?.purpose ?? s.purpose ?? DEFAULT_PURPOSE)?.address ?? null;
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
  for (const name of await credentials.list()) {
    if (!name.startsWith(`${site}@`) && !name.startsWith(`${site}-`)) continue;
    const c = await credentials.get(name);
    if (c && same(c.username, account)) return name;
  }
  return null;
}

export function sitesFor(p: SiteParts): SiteFacade {
  // What setup keeps is visible to the next call at once, whichever sink is behind it.
  const made = new Map<string, string>();
  const env = p.env ?? ((name: string) => process.env[name]);
  const flows = p.flows ?? BROWSER_FLOWS;
  return siteFacade(p.sites ?? SITES, {
    http: p.http ?? httpClient(),
    env: (name) => made.get(name) ?? env(name),
    sink: {
      put: async (name, value) => {
        await p.sink.put(name, value);
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
    ...(p.credentials
      ? {
          profileFor: (site, account) => profileOf(p.credentials as CredentialStore, site, account),
          providerOf: consentProviderOf,
        }
      : {}),
    ...(p.identities
      ? {
          accountFor: async (s, step) =>
            accountForSite(await (p.identities as () => Promise<Identity[]>)(), s, step),
        }
      : {}),
  });
}
