/** Every client the flow needs, built once from settings. Secrets stay inside the clients. */
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Logger } from "pino";
import { flowRunner } from "./browser/flow.js";
import type { BrowserOptions } from "./browser/session.js";
import { cloudflare } from "./clients/cloudflare.js";
import { gmailClient } from "./clients/gmail.js";
import { googleAdmin } from "./clients/google-admin.js";
import { httpClient } from "./clients/http.js";
import { domainAvailability } from "./clients/rdap.js";
import { ssmRosterStore } from "./clients/roster.js";
import { wrenClient } from "./clients/wren.js";
import type { Settings } from "./config.js";
import type { Deps } from "./flow/steps.js";
import {
  loadServiceAccountKey,
  SCOPES,
  serviceAccountToken,
  type TokenSupplier,
} from "./google-auth.js";
import { makeDomainProvision } from "./restate/domain-provision.js";

function required<T>(value: T | undefined, env: string): T {
  if (value === undefined) throw new Error(`${env} is required`);
  return value;
}

export function browserOptions(settings: Settings, headless = true): BrowserOptions {
  return {
    tier: settings.browser,
    profilesDir: settings.profilesDir,
    artifactsDir: settings.artifactsDir,
    headless,
    browserbase:
      settings.browserbaseApiKey && settings.browserbaseProjectId
        ? {
            apiKey: settings.browserbaseApiKey,
            projectId: settings.browserbaseProjectId,
            http: httpClient(),
          }
        : null,
  };
}

export function buildDeps(settings: Settings, log: Logger): Deps {
  const http = httpClient();
  const key = loadServiceAccountKey(
    required(settings.googleServiceAccount, "GOOGLE_SERVICE_ACCOUNT"),
  );
  const admin = required(settings.googleAdminUser, "GOOGLE_ADMIN_USER");
  // One token supplier per (subject, scopes); each caches its bearer until a minute before expiry.
  const tokens = new Map<string, TokenSupplier>();
  const tokenFor = (subject: string, scopes: readonly string[]): TokenSupplier => {
    const k = `${subject} ${scopes.join(" ")}`;
    let t = tokens.get(k);
    if (!t) {
      t = serviceAccountToken(key, { scopes, subject });
      tokens.set(k, t);
    }
    return t;
  };
  const gmail = gmailClient({
    tokenFor,
    scopes: { settings: SCOPES.gmailSettings, send: SCOPES.gmailSend },
    http,
  });
  const ssm = new SSMClient({ region: settings.awsRegion });
  const notifyTo = settings.notifyTo;
  const notifyFrom = settings.notifyFrom ?? settings.notifyTo;

  return {
    cloudflare: cloudflare({
      apiToken: required(settings.cloudflareApiToken, "CLOUDFLARE_API_TOKEN"),
      accountId: required(settings.cloudflareAccountId, "CLOUDFLARE_ACCOUNT_ID"),
      http,
    }),
    google: googleAdmin({
      token: tokenFor(admin, [
        SCOPES.directoryDomain,
        SCOPES.directoryUser,
        SCOPES.siteVerification,
      ]),
      http,
    }),
    gmail,
    roster: ssmRosterStore({ param: settings.rosterSsmParam, region: settings.awsRegion }),
    wren: wrenClient({
      ingressUrl: settings.restateIngressUrl,
      authToken: settings.restateAuthToken ?? null,
      githubToken: settings.githubToken ?? null,
      repo: settings.wrenRepo,
      http,
    }),
    availability: (domain) => domainAvailability(http, domain),
    browser: flowRunner(browserOptions(settings)),
    secrets: {
      put: async (name, value) => {
        await ssm.send(
          new PutParameterCommand({
            Name: name,
            Value: value,
            Type: "SecureString",
            Overwrite: true,
          }),
        );
      },
    },
    notify: async (subject, text) => {
      if (!notifyTo || !notifyFrom) {
        log.warn({ subject }, "NOTIFY_TO unset: not mailed");
        return;
      }
      await gmail.send({ from: notifyFrom, to: notifyTo, subject, text });
    },
    dmarcRua: settings.dmarcRua ?? null,
  };
}

export function buildServices(settings: Settings, log: Logger) {
  return [makeDomainProvision(buildDeps(settings, log))];
}
