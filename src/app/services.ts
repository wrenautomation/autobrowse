/** Composition root: settings → clients → workflow deps → Restate services. Secrets stay inside the clients. */

import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Logger } from "pino";
import {
  aesGcmCipher,
  type CredentialStore,
  codeSources,
  envCredentials,
  fileCredentials,
  keychainKey,
  type LoginProvider,
  layeredCredentials,
  loginProvider,
  messageSource,
  plainCipher,
  SITE_LOGINS,
  totpSource,
} from "../auth/index.js";
import { flowRunner } from "../browser/flow.js";
import { llmRepairer, noRepairer, rememberingRepairer } from "../browser/repair.js";
import type { BrowserOptions } from "../browser/session.js";
import {
  type Channel,
  channels,
  emailChannel,
  memoryChannel,
  webhookChannel,
} from "../channels/index.js";
import { cloudflare, verifyCloudflareToken } from "../clients/cloudflare.js";
import { type GmailUserClient, gmailClient } from "../clients/gmail.js";
import { googleAdmin } from "../clients/google-admin.js";
import { httpClient } from "../clients/http.js";
import { domainAvailability } from "../clients/rdap.js";
import { ssmRosterStore } from "../clients/roster.js";
import { twilioReader } from "../clients/twilio.js";
import { wrenClient } from "../clients/wren.js";
import { envFileSink, type SecretSink } from "../deps/sink.js";
import { Unrecoverable } from "../engine/effects.js";
import { parseGuards } from "../engine/guards.js";
import { makeRunObject } from "../engine/object.js";
import { runsRegistry } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import {
  loadServiceAccountKey,
  SCOPES,
  serviceAccountToken,
  type TokenSupplier,
} from "../google-auth.js";
import { makeLlm } from "../llm/index.js";
import { backboardMemory, type Memory, memoryStore } from "../memory/index.js";
import { type EventBus, eventBus } from "../ui/bus.js";
import { type BootstrapDeps, bootstrapWorkflow } from "../workflows/bootstrap/index.js";
import { type DomainDeps, domainWorkflow } from "../workflows/domain/index.js";
import type { Settings } from "./config.js";

function required<T>(value: T | undefined, env: string): T {
  if (value === undefined) throw new Unrecoverable(`${env} is required`);
  return value;
}

/**
 * Build a client the first time a step touches it, so a worker starts
 * with whatever credentials it has and a missing one fails the step that
 * needs it (a clear `X is required` in the run), not the whole process.
 */
function lazy<T extends object>(make: () => T): T {
  let real: T | null = null;
  return new Proxy({} as T, {
    get(_t, prop) {
      real ??= make();
      const v = Reflect.get(real, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  });
}

export function browserOptions(
  settings: Settings,
  headless = settings.browserHeadless,
): BrowserOptions {
  return {
    tier: settings.browser,
    profilesDir: settings.profilesDir,
    channel: settings.browserChannel,
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

export function llmFor(settings: Settings, http = httpClient()) {
  return makeLlm(
    {
      provider: settings.llmProvider,
      model: settings.llmModel,
      anthropicApiKey: settings.anthropicApiKey,
      openaiApiKey: settings.openaiApiKey,
      openaiBaseUrl: settings.openaiBaseUrl,
    },
    http,
  );
}

/** The workflows this worker serves. Adding one is one line here. */
export const WORKFLOWS: readonly AnyWorkflow[] = [domainWorkflow, bootstrapWorkflow];

export interface App {
  services:
    | ReturnType<typeof makeRunObject>[]
    | Array<ReturnType<typeof makeRunObject> | typeof runsRegistry>;
  channel: Channel;
  /** The UI's live feed; also one of the channels. */
  bus: EventBus;
  memory: Memory;
}

/** Env credentials first (a Secret in k8s), then the sealed 0600 file; writes go to the file. */
export function credentialsFor(settings: Settings): CredentialStore {
  const cipher =
    settings.credentialsCipher === "keychain" ? aesGcmCipher(keychainKey()) : plainCipher;
  return layeredCredentials([envCredentials(), fileCredentials(settings.credentialsFile, cipher)]);
}

/** Sign-in for every known site: TOTP from the stored seed, email codes through Gmail, SMS through Twilio. */
export function loginFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): LoginProvider {
  const sources = [
    totpSource(),
    messageSource({
      kind: "email",
      reader: gmail,
      ...(settings.codesInbox ? { inbox: settings.codesInbox } : {}),
    }),
  ];
  if (settings.twilioAccountSid && settings.twilioAuthToken && settings.twilioNumber)
    sources.push(
      messageSource({
        kind: "sms",
        inbox: settings.twilioNumber,
        reader: twilioReader({
          accountSid: settings.twilioAccountSid,
          authToken: settings.twilioAuthToken,
          http,
        }),
      }),
    );
  return loginProvider(SITE_LOGINS, {
    credentials: credentialsFor(settings),
    codes: codeSources(...sources),
  });
}

export function memoryFor(settings: Settings, http = httpClient()): Memory {
  if (settings.memory === "backboard" && settings.backboardApiKey)
    return backboardMemory({
      apiKey: settings.backboardApiKey,
      http,
      assistant: settings.backboardAssistant,
    });
  return memoryStore();
}

/** Google: one service-account key, one token supplier per (subject, scopes), each caching its bearer. */
export function googleTokens(settings: Settings) {
  const tokens = new Map<string, TokenSupplier>();
  let key: ReturnType<typeof loadServiceAccountKey> | null = null;
  const tokenFor = (subject: string, scopes: readonly string[]): TokenSupplier => {
    const k = `${subject} ${scopes.join(" ")}`;
    let t = tokens.get(k);
    if (!t) {
      key ??= loadServiceAccountKey(
        required(settings.googleServiceAccount, "GOOGLE_SERVICE_ACCOUNT"),
      );
      t = serviceAccountToken(key, { scopes, subject });
      tokens.set(k, t);
    }
    return t;
  };
  return tokenFor;
}

export function gmailFor(settings: Settings, http = httpClient()): GmailUserClient {
  return gmailClient({
    tokenFor: googleTokens(settings),
    scopes: { settings: SCOPES.gmailSettings, send: SCOPES.gmailSend, read: SCOPES.gmailRead },
    http,
  });
}

export function buildApp(settings: Settings, log: Logger): App {
  const http = httpClient();
  const llm = llmFor(settings, http);
  const memory = memoryFor(settings, http);
  const tokenFor = googleTokens(settings);
  const gmail = gmailFor(settings, http);
  const ssm = lazy(() => new SSMClient({ region: settings.awsRegion }));

  const list: Channel[] = [];
  const notifyFrom = settings.notifyFrom ?? settings.googleAdminUser;
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
  const bus = eventBus();
  const channel = channels([...list, bus, memoryChannel(memory)]);

  const guards = parseGuards(settings.guards);
  const browser = flowRunner(browserOptions(settings), {
    repairer: rememberingRepairer(memory, llm ? llmRepairer(llm) : noRepairer),
    login: loginFor(settings, gmail),
    repairIrreversible: !guards.has("irreversible"),
    onRepair: (r) =>
      log.warn(
        { repair: r },
        `locator ${r.ok ? "repaired" : "not repaired"} in ${r.flow}: ${r.goal}`,
      ),
  });

  const domainDeps: DomainDeps = {
    cloudflare: lazy(() =>
      cloudflare({
        apiToken: required(settings.cloudflareApiToken, "CLOUDFLARE_API_TOKEN"),
        accountId: required(settings.cloudflareAccountId, "CLOUDFLARE_ACCOUNT_ID"),
        http,
      }),
    ),
    google: lazy(() =>
      googleAdmin({
        token: tokenFor(required(settings.googleAdminUser, "GOOGLE_ADMIN_USER"), [
          SCOPES.directoryDomain,
          SCOPES.directoryUser,
          SCOPES.siteVerification,
        ]),
        http,
      }),
    ),
    gmail,
    roster: lazy(() =>
      ssmRosterStore({ param: settings.rosterSsmParam, region: settings.awsRegion }),
    ),
    wren: wrenClient({
      ingressUrl: settings.restateIngressUrl,
      authToken: settings.restateAuthToken ?? null,
      githubToken: settings.githubToken ?? null,
      repo: settings.wrenRepo,
      http,
    }),
    availability: (domain) => domainAvailability(http, domain),
    browser,
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

  const sink: SecretSink =
    settings.secretSink === "ssm"
      ? {
          put: async (name, value) => {
            await ssm.send(
              new PutParameterCommand({
                Name: `/autobrowse/config/${name}`,
                Value: value,
                Type: "SecureString",
                Overwrite: true,
              }),
            );
          },
        }
      : envFileSink(settings.envFile);
  const bootstrapDeps: BootstrapDeps = {
    browser,
    sink,
    current: () => ({
      cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN ?? settings.cloudflareApiToken ?? null,
      cloudflareAccountId:
        process.env.CLOUDFLARE_ACCOUNT_ID ?? settings.cloudflareAccountId ?? null,
    }),
    verifyCloudflareToken: (token) => verifyCloudflareToken(http, token),
  };

  const host = { emit: (e: Parameters<Channel["deliver"]>[0]) => channel.deliver(e) };
  return {
    services: [
      runsRegistry,
      makeRunObject(domainWorkflow, domainDeps, host, { guards }),
      makeRunObject(bootstrapWorkflow, bootstrapDeps, host, { guards }),
    ],
    channel,
    bus,
    memory,
  };
}
