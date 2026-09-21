/** Composition root: settings → clients → workflow deps → Restate services. Secrets stay inside the clients. */

import { dirname, join } from "node:path";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Logger } from "pino";
import {
  aesGcmCipher,
  type CodeSource,
  type CredentialStore,
  codeSources,
  credentialFor,
  envCredentials,
  fileAudit,
  fileCredentials,
  keychainKey,
  type LoginProvider,
  layeredCredentials,
  loginProvider,
  messageSource,
  plainCipher,
  type SecretAudit,
  SITE_LOGINS,
  totpSource,
} from "../auth/index.js";
import type { FlowRunner } from "../browser/flow.js";
import { flowRunner, HUMAN_PACE, type Pace } from "../browser/flow.js";
import { llmRepairer, noRepairer, rememberingRepairer } from "../browser/repair.js";
import type { BrowserOptions, FailureRecord } from "../browser/session.js";
import {
  type Channel,
  channels,
  emailChannel,
  linqChannel,
  memoryChannel,
  phoneChannel,
  webhookChannel,
} from "../channels/index.js";
import { cloudflare, verifyCloudflareToken } from "../clients/cloudflare.js";
import { type GmailUserClient, gmailClient } from "../clients/gmail.js";
import { googleAdmin } from "../clients/google-admin.js";
import { httpClient } from "../clients/http.js";
import { type LinqClient, linqClient } from "../clients/linq.js";
import { domainAvailability } from "../clients/rdap.js";
import { ssmRosterStore } from "../clients/roster.js";
import { twilioReader } from "../clients/twilio.js";
import { wrenClient } from "../clients/wren.js";
import { type EnvStore, ssmEnvStore } from "../deps/env-store.js";
import { envFileSink, type SecretSink } from "../deps/sink.js";
import {
  openFullDiskAccessPane,
  type PhoneOptions,
  phoneReader,
  phoneStatus,
} from "../devices/phone.js";
import type { Doer } from "../do/doer.js";
import { doService } from "../do/service.js";
import { type BrowserService, browserService } from "../engine/browser-service.js";
import { Unrecoverable } from "../engine/effects.js";
import { parseGuards } from "../engine/guards.js";
import { makeRunObject } from "../engine/object.js";
import { runsRegistry } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { askOverChannel } from "../gates/ask.js";
import type { Approver } from "../gates/payment.js";
import {
  expandHome,
  loadServiceAccountKey,
  SCOPES,
  serviceAccountToken,
  type TokenSupplier,
} from "../google-auth.js";
import { type BudgetExceeded, type BudgetedLlm, budgetedLlm, fileLedger } from "../llm/budget.js";
import { type Llm, makeLlm } from "../llm/index.js";
import { backboardMemory, type Memory, memoryStore } from "../memory/index.js";
import {
  accessTokens,
  accountEnv,
  gmailOAuth,
  type SiteFacade,
  type SitesService,
  sitesFor,
  sitesService,
} from "../sites/index.js";
import { type EventBus, eventBus } from "../ui/bus.js";
import { type BootstrapDeps, bootstrapWorkflow } from "../workflows/bootstrap/index.js";
import {
  type CompiledCatalog,
  compiledCatalog,
  makeCompiledRunObject,
} from "../workflows/compiled.js";
import { type DomainDeps, domainWorkflow } from "../workflows/domain/index.js";
import type { Proof } from "../workflows/proof.js";
import type { Settings } from "./config.js";
import { holding, type Idle, idleTracker } from "./idle.js";
import { type Screen, screenOf } from "./screen.js";
import type { DeviceLink } from "./setup.js";

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
  screen: Screen = screenOf(settings),
): BrowserOptions {
  const store = credentialsFor(settings);
  return {
    // Read when a browser opens, so the switch applies to the next one.
    get headless() {
      return screen.headless;
    },
    // The site's account's passkeys ride along in its session.
    passkeys: async (site) => {
      return (await store.get(credentialFor(SITE_LOGINS, site)))?.passkeys ?? [];
    },
    tier: settings.browser,
    cdpUrl: settings.browserCdpUrl ?? null,
    profilesDir: settings.profilesDir,
    channel: settings.browserChannel,
    artifactsDir: settings.artifactsDir,
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

/** The model behind everything, under the daily cap when one is set (`LLM_DAILY_TOKENS`). */
export function llmFor(
  settings: Settings,
  http = httpClient(),
  onExceeded?: (err: BudgetExceeded) => void,
): BudgetedLlm | Llm | null {
  const llm = makeLlm(
    {
      provider: settings.llmProvider,
      model: settings.llmModel,
      anthropicApiKey: settings.anthropicApiKey,
      openaiApiKey: settings.openaiApiKey,
      openaiBaseUrl: settings.openaiBaseUrl,
    },
    http,
  );
  if (!llm || settings.llmDailyTokens === 0) return llm;
  return budgetedLlm(llm, {
    dailyTokens: settings.llmDailyTokens,
    ledger: fileLedger(join(expandHome(settings.artifactsDir), "llm-budget.json")),
    ...(onExceeded ? { onExceeded } : {}),
  });
}

/** The cap and today's spend, for the status page; null when there is no cap. */
export function budgetOf(llm: Llm | null): { cap: number; usedToday: number } | null {
  if (!llm || !("usedToday" in llm)) return null;
  const b = llm as BudgetedLlm;
  return { cap: b.cap, usedToday: b.usedToday() };
}

/** The hand-written workflows; compiled ones are found per run by the Compiled object (see workflows/compiled.ts). */
export const WORKFLOWS: readonly AnyWorkflow[] = [domainWorkflow, bootstrapWorkflow];

/** Where compiled workflows live and where the compiler writes; relative imports resolve to the library from there. */
export const COMPILED_DIR = "src/workflows";
export const COMPILED_LIB = "../../index.js";

export interface App {
  services: Array<
    | ReturnType<typeof makeRunObject>
    | typeof runsRegistry
    | BrowserService
    | SitesService
    | ReturnType<typeof doService>
  >;
  channel: Channel;
  /** Hand-written plus compiled, as of now: a compile shows up at once. */
  workflows(): Promise<readonly AnyWorkflow[]>;
  /** Compiled workflows' last proof runs by name (hand-written ones have none). */
  proofs(): Promise<Record<string, Proof | null>>;
  catalog: CompiledCatalog;
  /** The worker's browser runner: what compiled flows and proof runs use. */
  browser: FlowRunner;
  /** The UI's live feed; also one of the channels. */
  bus: EventBus;
  memory: Memory;
  /** Where minted secrets go (`keep` ops, bootstrap). */
  sink: SecretSink;
  /** The site APIs, one instance: the HTTP face, the CLI and the `sites` service share it. */
  sites: SiteFacade;
  /** Busy while a flow or site call runs; touched by every event. The idle stop reads it. */
  idle: Idle;
  /** Headed or headless for every browser opened from now; the API flips it. */
  screen: Screen;
  /** The sealed credential store (env layer first); the Accounts page and `creds` write to it. */
  credentials: CredentialStore;
  /** Set by the host once the agent exists: every failure record goes here (healing). */
  onFailure: ((record: FailureRecord, file: string) => void) | null;
  /** Set by the host once the backend exists: the `do` service runs goals through it (held busy). */
  doer: Doer | null;
}

/** Env credentials first (a Secret in k8s), then the sealed 0600 file; writes go to the file. */
export function credentialsFor(settings: Settings): CredentialStore {
  const cipher =
    settings.credentialsCipher === "keychain" ? aesGcmCipher(keychainKey()) : plainCipher;
  return layeredCredentials([envCredentials(), fileCredentials(settings.credentialsFile, cipher)]);
}

/** Where every secret use is written: next to the credential file, 0600, one JSON line each. */
export function auditFor(settings: Settings): SecretAudit {
  return fileAudit(join(dirname(expandHome(settings.credentialsFile)), "audit.jsonl"));
}

/** The paired phone, when one is configured: reader, notifier and channel share these options. */
export function phoneFor(settings: Settings): PhoneOptions | null {
  if (!settings.phoneNumber) return null;
  return {
    number: settings.phoneNumber,
    ...(settings.phoneMessagesDb ? { dbPath: settings.phoneMessagesDb } : {}),
  };
}

/** What `setup` checks and guides: the phone link when a number is configured. */
export function devicesFor(settings: Settings): DeviceLink[] {
  const phone = phoneFor(settings);
  if (!phone) return [];
  return [
    {
      name: `phone ${phone.number}`,
      async check() {
        const st = await phoneStatus(phone.dbPath);
        return { ok: st.read && st.send, fix: st.fix };
      },
      guide: async () => {
        if (!(await phoneStatus(phone.dbPath)).read) await openFullDiskAccessPane();
      },
    },
  ];
}

/**
 * Every way a code reaches us: TOTP from the stored seed, email through
 * Gmail, SMS from the paired phone and/or Linq and/or Twilio (all first
 * class; the phone is asked first).
 */
export function codesFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): CodeSource {
  const sources = [
    totpSource(),
    messageSource({
      kind: "email",
      reader: gmail,
      ...(settings.codesInbox ? { inbox: settings.codesInbox } : {}),
    }),
  ];
  const phone = phoneFor(settings);
  if (phone)
    sources.push(messageSource({ kind: "sms", inbox: phone.number, reader: phoneReader(phone) }));
  const linq = linqFor(settings, http);
  if (linq)
    sources.push(messageSource({ kind: "sms", inbox: linq.to, reader: linq.client.reader() }));
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
  return codeSources(...sources);
}

/** The number a site may text us on: the paired phone, else Linq, else Twilio. */
export function ourPhone(settings: Settings, http = httpClient()): string | null {
  return phoneFor(settings)?.number ?? linqFor(settings, http)?.to ?? settings.twilioNumber ?? null;
}

/**
 * Sign-in for every known site: codes from `codesFor`, device prompts by
 * a note over every channel that reaches a person (phone, email).
 */
export function loginFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): LoginProvider {
  const people = channelsFor(settings, gmail, http).filter((c) => c.note);
  const all = channels(people);
  const notify = people.length && all.note ? all.note.bind(all) : undefined;
  return loginProvider(SITE_LOGINS, {
    credentials: credentialsFor(settings),
    codes: codesFor(settings, gmail, http),
    audit: auditFor(settings),
    ...(notify ? { notify } : {}),
  });
}

/** Linq when the key and our number are set; the operator's number falls back to the paired phone's. */
export function linqFor(
  settings: Settings,
  http = httpClient(),
): { client: LinqClient; to: string } | null {
  const to = settings.linqTo ?? settings.phoneNumber;
  if (!settings.linqApiKey || !settings.linqNumber || !to) return null;
  return {
    client: linqClient({ apiKey: settings.linqApiKey, from: settings.linqNumber, http }),
    to,
  };
}

/** The runner's pace from settings; `fast` means no delays at all. */
export function paceFor(settings: Settings): Pace | null {
  return settings.pace === "fast" ? null : HUMAN_PACE;
}

/** Where minted secrets go: the env store (SSM) in prod, the env file otherwise. */
export function sinkFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient({ region: settings.awsRegion })),
): SecretSink {
  if (settings.secretSink !== "ssm") return envFileSink(settings.envFile);
  return { put: (name, value) => envStoreFor(settings, ssm).put(name, value) };
}

/** The store `autobrowse env` and prod's sink share: SSM under /autobrowse/config. */
export function envStoreFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient({ region: settings.awsRegion })),
): EnvStore {
  return ssmEnvStore(ssm);
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

/**
 * Google, one token supplier per (subject, scopes), each caching its bearer:
 * an account that consented (`site setup gmail consent --account <it>`,
 * `GMAIL_REFRESH_TOKEN__<IT>`) is acted as through its own refresh token;
 * every other subject through the service account (domain-wide delegation,
 * our Workspace only).
 */
export function googleTokens(
  settings: Settings,
  env: (name: string) => string | undefined = (n) => process.env[n],
  http = httpClient(),
) {
  const tokens = new Map<string, TokenSupplier>();
  let key: ReturnType<typeof loadServiceAccountKey> | null = null;
  const consented = accessTokens(http, env);
  const tokenFor = (subject: string, scopes: readonly string[]): TokenSupplier => {
    const k = `${subject} ${scopes.join(" ")}`;
    let t = tokens.get(k);
    if (!t && env(accountEnv(gmailOAuth.refreshToken, subject))) {
      t = async () => {
        const token = await consented(gmailOAuth, subject);
        if (!token) throw new Error(`no Gmail token for ${subject}`);
        return token;
      };
      tokens.set(k, t);
    }
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

/** The ways to reach people and systems, from settings: email, the paired phone, a webhook. */
/**
 * Who answers a payment gate: the first channel the person both hears and
 * can reply on (phone → Linq → email); null when there is none, and then
 * the session refuses the act rather than guessing.
 */
export function approverFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): Approver | null {
  const phone = phoneFor(settings);
  if (phone) {
    const ch = phoneChannel(phone);
    if (ch.note)
      return askOverChannel({
        note: ch.note.bind(ch),
        reader: phoneReader(phone),
        inbox: phone.number,
      });
  }
  const linq = linqFor(settings, http);
  if (linq) {
    const ch = linqChannel(linq);
    if (ch.note)
      return askOverChannel({
        note: ch.note.bind(ch),
        reader: linq.client.reader(),
        inbox: linq.to,
      });
  }
  const notifyFrom = settings.notifyFrom ?? settings.googleAdminUser;
  if (settings.notifyTo && notifyFrom) {
    const ch = emailChannel({ gmail, from: notifyFrom, to: settings.notifyTo });
    if (ch.note)
      return askOverChannel({ note: ch.note.bind(ch), reader: gmail, inbox: notifyFrom }); // replies land in the sender's inbox
  }
  return null;
}

export function channelsFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): Channel[] {
  const list: Channel[] = [];
  const notifyFrom = settings.notifyFrom ?? settings.googleAdminUser;
  if (settings.notifyTo && notifyFrom)
    list.push(emailChannel({ gmail, from: notifyFrom, to: settings.notifyTo }));
  const phone = phoneFor(settings);
  if (phone) list.push(phoneChannel(phone));
  const linq = linqFor(settings, http);
  if (linq) list.push(linqChannel(linq));
  if (settings.webhookUrl)
    list.push(
      webhookChannel({
        url: settings.webhookUrl,
        http,
        ...(settings.webhookToken ? { token: settings.webhookToken } : {}),
      }),
    );
  return list;
}

export async function buildApp(settings: Settings, log: Logger): Promise<App> {
  const http = httpClient();
  const llm = llmFor(settings, http);
  const memory = memoryFor(settings, http);
  const tokenFor = googleTokens(settings);
  const gmail = gmailFor(settings, http);
  const ssm = lazy(() => new SSMClient({ region: settings.awsRegion }));

  const list = channelsFor(settings, gmail, http);
  if (list.length === 0) log.warn("no channel configured: gates are visible only in the UI/CLI");
  const bus = eventBus();
  const channel = channels([...list, bus, memoryChannel(memory)]);
  const idle = idleTracker();
  bus.subscribe(() => idle.touch());
  const screen = screenOf(settings);

  const guards = parseGuards(settings.guards);
  const failures: { hook: App["onFailure"] } = { hook: null };
  const browser = holding(
    idle,
    flowRunner(browserOptions(settings, screen), {
      onFailure: (record, file) => failures.hook?.(record, file),
      pace: paceFor(settings),
      repairer: rememberingRepairer(memory, llm ? llmRepairer(llm) : noRepairer),
      login: loginFor(settings, gmail),
      repairIrreversible: !guards.has("irreversible"),
      onRepair: (r) =>
        log.warn(
          { repair: r },
          `locator ${r.ok ? "repaired" : "not repaired"} in ${r.flow}: ${r.goal}`,
        ),
    }),
  );

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

  const sink = sinkFor(settings, ssm);
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
  /** The catalog is read on every listing; a broken flow is said once per distinct error, not per request. */
  const warned = new Set<string>();
  const catalog = compiledCatalog(COMPILED_DIR, (dir, err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (warned.has(`${dir}\n${message}`)) return;
    warned.add(`${dir}\n${message}`);
    log.warn({ dir, err: message }, "compiled workflow not loaded");
  });
  const taken = new Set(WORKFLOWS.map((w) => w.name));
  /** Compiled flows, minus any that clashes with a hand-written name (said once). */
  const compiledNow = async () =>
    (await catalog.list()).filter((c) => {
      if (!taken.has(c.workflow.name)) return true;
      if (!warned.has(c.dir)) {
        warned.add(c.dir);
        log.warn(
          { dir: c.dir },
          `compiled workflow ${c.workflow.name} clashes with a hand-written one; skipped`,
        );
      }
      return false;
    });
  const extra = await compiledNow();
  if (extra.length) log.info({ compiled: extra.map((c) => c.workflow.name) }, "compiled workflows");
  const sites = holding(
    idle,
    sitesFor({
      catalog,
      browser,
      sink,
      oauthPort: settings.oauthPort,
      credentials: credentialsFor(settings),
    }),
  );
  const late: { doer: Doer | null } = { doer: null };
  return {
    services: [
      runsRegistry,
      // The browser legs for an orchestrator that owns the API steps (wren); compiled flows by name too.
      browserService({ runner: browser }),
      // The site APIs for the same orchestrator: official shapes, durable over the tunnel.
      sitesService(sites),
      // One verb for the same orchestrator; the backend wires the doer in after the model exists.
      doService(() => (late.doer ? holding(idle, late.doer) : null)),
      makeRunObject(domainWorkflow, domainDeps, host, { guards }),
      makeRunObject(bootstrapWorkflow, bootstrapDeps, host, { guards }),
      // Every compiled flow, present and future, runs under this one object.
      makeCompiledRunObject({ catalog, browser, host, opts: { guards }, sink }),
    ],
    channel,
    workflows: async () => [...WORKFLOWS, ...(await compiledNow()).map((c) => c.workflow)],
    proofs: async () =>
      Object.fromEntries((await compiledNow()).map((c) => [c.workflow.name, c.proof])),
    catalog,
    browser,
    bus,
    memory,
    sink,
    sites,
    idle,
    screen,
    credentials: credentialsFor(settings),
    get onFailure() {
      return failures.hook;
    },
    set onFailure(hook) {
      failures.hook = hook;
    },
    get doer() {
      return late.doer;
    },
    set doer(d) {
      late.doer = d;
    },
  };
}
