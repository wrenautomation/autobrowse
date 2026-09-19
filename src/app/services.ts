/** Composition root: settings → clients → workflow deps → Restate services. Secrets stay inside the clients. */
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Logger } from "pino";
import { flowRunner } from "../browser/flow.js";
import type { BrowserOptions } from "../browser/session.js";
import { type Channel, channels, emailChannel, webhookChannel } from "../channels/index.js";
import { cloudflare } from "../clients/cloudflare.js";
import { gmailClient } from "../clients/gmail.js";
import { googleAdmin } from "../clients/google-admin.js";
import { httpClient } from "../clients/http.js";
import { domainAvailability } from "../clients/rdap.js";
import { ssmRosterStore } from "../clients/roster.js";
import { wrenClient } from "../clients/wren.js";
import { makeRunObject } from "../engine/object.js";
import { runsRegistry } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import {
  loadServiceAccountKey,
  SCOPES,
  serviceAccountToken,
  type TokenSupplier,
} from "../google-auth.js";
import { type DomainDeps, domainWorkflow } from "../workflows/domain/index.js";
import type { Settings } from "./config.js";

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

/** The workflows this worker serves. Adding one is one line here. */
export const WORKFLOWS: readonly AnyWorkflow[] = [domainWorkflow];

export interface App {
  services:
    | ReturnType<typeof makeRunObject>[]
    | Array<ReturnType<typeof makeRunObject> | typeof runsRegistry>;
  channel: Channel;
}

export function buildApp(settings: Settings, log: Logger): App {
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

  const list: Channel[] = [];
  const notifyFrom = settings.notifyFrom ?? settings.notifyTo;
  if (settings.notifyTo && notifyFrom)
    list.push(emailChannel({ gmail, from: notifyFrom, to: settings.notifyTo }));
  if (settings.webhookUrl)
    list.push(
      webhookChannel({
        url: settings.webhookUrl,
        http,
        ...(settings.webhookToken ? { token: settings.webhookToken } : {}),
      }),
    );
  if (list.length === 0) log.warn("no channel configured: gates are visible only in the UI/CLI");
  const channel = channels(list);

  const domainDeps: DomainDeps = {
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
    dmarcRua: settings.dmarcRua ?? null,
  };

  const host = { emit: (e: Parameters<Channel["deliver"]>[0]) => channel.deliver(e) };
  return {
    services: [runsRegistry, makeRunObject(domainWorkflow, domainDeps, host)],
    channel,
  };
}
