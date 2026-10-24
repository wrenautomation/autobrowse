/** What each hand-written workflow calls, built from settings: bootstrap, the inbox fleet, inbox activity, the workspace inbox, domains. */
import { Resolver } from "node:dns/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { EnvStore } from "credvault";
import type { FlowRunner } from "../browser/flow.js";
import { awsDomain } from "../clients/aws-domain.js";
import { cloudflare, verifyCloudflareToken } from "../clients/cloudflare.js";
import { dynadot } from "../clients/dynadot.js";
import { type HttpClient, httpClient, safeUrl } from "../clients/http.js";
import { inboxInsiders } from "../clients/inbox-insiders.js";
import { type InstantlyClient, instantly } from "../clients/instantly.js";
import { ssmTextStore } from "../clients/roster.js";
import { wrenClient } from "../clients/wren.js";
import { isDefaultOwner } from "../owner.js";
import { accountEnv, type SiteFacade } from "../sites/index.js";
import type { BootstrapDeps } from "../workflows/bootstrap/index.js";
import type { DomainDeps } from "../workflows/domain/index.js";
import type { InboxActivityDeps } from "../workflows/inbox-activity/index.js";
import type { FleetDeps } from "../workflows/inbox-fleet/index.js";
import type { Probe } from "../workflows/inbox-fleet/steps.js";
import type { Consents, WorkspaceInboxDeps } from "../workflows/workspace-inbox/index.js";
import type { Settings } from "./config.js";
import { awsFor } from "./owner.js";
import { envStoreFor, ssmFor } from "./services-keys.js";
import { lazy, required } from "./services-kit.js";
import { gmailFor, googleAdminFor } from "./services-reach.js";
import { credentialsFor, identitiesFor } from "./services-state.js";

/**
 * Where minted secrets go, and are listed from with their expiry: the env
 * store (SSM) in prod; elsewhere the env file in front of it, so a token
 * minted on the laptop is on the box and survives the laptop.
 */
/** The bootstrap workflow's deps; the worker and `autobrowse cloudflare-token` share them. */
export function bootstrapDepsFor(
  settings: Settings,
  browser: FlowRunner,
  sink: EnvStore,
  http: HttpClient = httpClient(),
): BootstrapDeps {
  return {
    browser,
    sink,
    current: () => ({
      cloudflareAccountId:
        process.env.CLOUDFLARE_ACCOUNT_ID ?? settings.cloudflareAccountId ?? null,
    }),
    stored: async (key) =>
      process.env[key] ??
      (key === "CLOUDFLARE_API_TOKEN" ? settings.cloudflareApiToken : undefined) ??
      (await sink.get(key).catch(() => null)) ??
      null,
    verifyCloudflareToken: (token) => verifyCloudflareToken(http, token),
  };
}

/** Instantly with the key from the environment or the env store; null when neither has one. */
export async function instantlyFor(
  settings: Settings,
  http = httpClient(),
  ssm = ssmFor(settings),
): Promise<InstantlyClient | null> {
  const apiKey =
    process.env.INSTANTLY_API_KEY ||
    (await envStoreFor(settings, ssm)
      .get("INSTANTLY_API_KEY")
      .catch(() => null));
  return apiKey ? instantly({ apiKey, http }) : null;
}

/** What the inbox fleet calls: registrar, mailbox vendor, Instantly, AWS, public DNS. Keys from the environment or the env store. */
export function inboxFleetDepsFor(
  settings: Settings,
  http = httpClient(),
  ssm = ssmFor(settings),
): FleetDeps {
  const key = async (name: string) =>
    process.env[name] ||
    (await envStoreFor(settings, ssm)
      .get(name)
      .catch(() => null)) ||
    null;
  const keyed =
    <T>(name: string, make: (apiKey: string) => T) =>
    async () => {
      const k = await key(name);
      return k ? make(k) : null;
    };
  return {
    dynadot: keyed("DYNADOT_API_KEY", (apiKey) => dynadot({ apiKey, http })),
    inboxInsiders: keyed("INBOX_INSIDERS_API_KEY", (apiKey) => inboxInsiders({ apiKey, http })),
    instantly: () => instantlyFor(settings, http, ssm),
    orderKeys: async () => ({
      dynadot: required((await key("DYNADOT_API_KEY")) ?? undefined, "DYNADOT_API_KEY"),
      instantly: required((await key("INSTANTLY_API_KEY")) ?? undefined, "INSTANTLY_API_KEY"),
    }),
    aws: lazy(() => awsDomain(awsFor(settings))),
    credentials: credentialsFor(settings),
    mailboxes: {
      async merge(rows) {
        const store = ssmTextStore({ param: settings.mailboxesSsmParam, aws: awsFor(settings) });
        // Only a missing parameter starts empty; any other failed read must not drop the rows there.
        const held = await store.read().then(
          (text) => JSON.parse(text) as Record<string, unknown>,
          (err: { name?: string }) => {
            if (err.name === "ParameterNotFound") return {};
            throw err;
          },
        );
        await store.write(JSON.stringify({ ...held, ...rows }));
      },
    },
    probe: publicProbe(),
  };
}

/** DNS from public resolvers (not this machine's cache) and a page's status with redirects not followed. */
export function publicProbe(servers = ["1.1.1.1", "8.8.8.8"]): Probe {
  const dns = new Resolver();
  dns.setServers(servers);
  const none = () => [] as never[];
  return {
    ns: (d) => dns.resolveNs(d).catch(none),
    mx: async (d) => (await dns.resolveMx(d).catch(none)).map((r) => r.exchange.toLowerCase()),
    txt: async (n) => (await dns.resolveTxt(n).catch(none)).map((r) => r.join("")),
    page: async (url) => (await fetch(url, { redirect: "manual" })).status,
  };
}

/** What inbox-activity calls: the browser, the inbox's Gmail and plain HTTP. */
export function inboxActivityDepsFor(
  settings: Settings,
  browser: InboxActivityDeps["browser"],
  http = httpClient(),
): InboxActivityDeps {
  return { browser, gmail: gmailFor(settings, http), http };
}

/** A site's consent through the facade as one address; held = every token it makes is in the sink. */
export function consentsOf(sites: SiteFacade, sink: Pick<EnvStore, "list">): Consents {
  const makes = async (site: string) => {
    const step = (await sites.status(site)).setup.find((s) => s.name === "consent");
    if (!step) throw new Error(`${site} has no consent setup step`);
    return step.makes;
  };
  return {
    async held(site, address) {
      const names = await makes(site);
      const kept = new Set((await sink.list()).map((e) => e.name));
      return names.length > 0 && names.every((n) => kept.has(accountEnv(n, address)));
    },
    async run(site, address) {
      return (await sites.setup(site, "consent", address)).made;
    },
  };
}

/** What workspace-inbox calls: the domain family's APIs, plain HTTP, the sites' consents, the accounts list. */
export function workspaceInboxDepsFor(
  settings: Settings,
  browser: DomainDeps["browser"],
  sites: SiteFacade,
  sink: Pick<EnvStore, "list">,
  http = httpClient(),
  ssm = ssmFor(settings),
): WorkspaceInboxDeps {
  return {
    ...domainDepsFor(settings, browser, http, ssm),
    http,
    identities: identitiesFor(settings),
    consents: consentsOf(sites, sink),
  };
}

/** What the domain workflow calls: the worker's, and `try domain` in one process. */
export function domainDepsFor(
  settings: Settings,
  browser: DomainDeps["browser"],
  http = httpClient(),
  ssm = ssmFor(settings),
): DomainDeps {
  return {
    cloudflare: lazy(() =>
      cloudflare({
        apiToken: required(settings.cloudflareApiToken, "CLOUDFLARE_API_TOKEN"),
        accountId: required(settings.cloudflareAccountId, "CLOUDFLARE_ACCOUNT_ID"),
        http,
      }),
    ),
    google: lazy(() => googleAdminFor(settings, http)),
    gmail: gmailFor(settings, http),
    roster: lazy(() => ssmTextStore({ param: settings.rosterSsmParam, aws: awsFor(settings) })),
    // The handoff to wren is Wren's own; another owner's roster is written and left there.
    wren: isDefaultOwner(settings.owner)
      ? wrenClient({
          ingressUrl: settings.restateIngressUrl,
          authToken: settings.restateAuthToken ?? null,
          githubToken: settings.githubToken ?? null,
          repo: settings.wrenRepo,
          http,
        })
      : null,
    browser,
    credentials: credentialsFor(settings),
    download: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download ${safeUrl(url)}: HTTP ${r.status}`);
      const dir = mkdtempSync(join(tmpdir(), "autobrowse-dl-"));
      const file = join(dir, basename(new URL(url).pathname) || "file");
      writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      return file;
    },
    instantly: () => instantlyFor(settings, http, ssm),
    dmarcRua: settings.dmarcRua ?? null,
  };
}
