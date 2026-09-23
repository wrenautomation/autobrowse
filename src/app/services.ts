/** Composition root: settings → clients → workflow deps → Restate services. Secrets stay inside the clients. */

import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  aesGcmCipher,
  type CanaryOptions,
  type CredentialHistory,
  type CredentialStore,
  canaryStore,
  type EnvStore,
  envCredentials,
  envFileStore,
  fileAudit,
  fileCredentials,
  keychainKey,
  layeredCredentials,
  plainCipher,
  type SecretAudit,
  ssmCredentialHistory,
  ssmEnvStore,
  syncedCredentials,
  syncedEnvStore,
} from "credvault";
import type { Logger } from "pino";
import { fileStepLedger, type StepLedger } from "../agent/ledger.js";
import { type Look, lookForAccount, RESET_FORMS } from "../auth/exists.js";
import {
  envIdentities,
  fileIdentities,
  type IdentityStore,
  layeredIdentities,
} from "../auth/identities.js";
import {
  type CodeSource,
  codeSources,
  credentialFor,
  type LoginProvider,
  loginProvider,
  messageSource,
  SITE_LOGINS,
  totpSource,
} from "../auth/index.js";
import { CRED_ENV, ENV_STORE_PREFIX, KEYCHAIN } from "../auth/keep.js";
import type { FlowRunner } from "../browser/flow.js";
import { flowRunner } from "../browser/flow.js";
import { resetMailProbe } from "../browser/flows/reset-mail-probe.js";
import { HUMAN_PACE, type Pace } from "../browser/human/index.js";
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
import { type HttpClient, httpClient } from "../clients/http.js";
import { type LinqClient, linqClient } from "../clients/linq.js";
import { domainAvailability } from "../clients/rdap.js";
import { ssmRosterStore } from "../clients/roster.js";
import { twilioReader } from "../clients/twilio.js";
import { wrenClient } from "../clients/wren.js";
import type { SecretSink } from "../deps/sink.js";
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
  fileSpendLedger,
  policedApprover,
  type SpendLedger,
  type SpendPolicy,
} from "../gates/spend.js";
import {
  delegatedScopes,
  expandHome,
  loadServiceAccountKey,
  SCOPES,
  serviceAccountToken,
  type TokenSupplier,
} from "../google-auth.js";
import { type BudgetExceeded, type BudgetedLlm, budgetedLlm, fileLedger } from "../llm/budget.js";
import { type Llm, makeLlm } from "../llm/index.js";
import { otlpSink, type TraceSink, tracedLlm } from "../llm/trace.js";
import { backboardMemory, type Memory, memoryStore } from "../memory/index.js";
import { s3BlobStore } from "../shots/s3.js";
import { keepArtifact, keepRecording, type ShipReport, shipShots } from "../shots/ship.js";
import {
  accessTokens,
  accountEnv,
  gmailOAuth,
  profileOf,
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
import { headed, type Screen, screenOf } from "./screen.js";
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

/**
 * The profile a site's browser work belongs in: its own, or — when its
 * credential signs in through a provider's button — the provider's, where
 * that session already lives. One Google sign-in then answers every
 * "Continue with Google" instead of each site's profile asking again.
 */
export async function profileForSite(settings: Settings, site: string): Promise<string | null> {
  const store = credentialsFor(settings);
  const cred = await store.get(credentialFor(SITE_LOGINS, site));
  if (!cred?.via) return null;
  return (await profileOf(store, cred.via, cred.username)) ?? cred.via;
}

/**
 * `browserOptions` for one site's work, in the profile its credential says:
 * the site's own, or the provider's when it signs in through a button there.
 */
export async function browserFor(
  settings: Settings,
  site: string,
  screen?: Screen,
): Promise<BrowserOptions> {
  const opts = screen ? browserOptions(settings, screen) : browserOptions(settings);
  const profile = await profileForSite(settings, site);
  return profile ? { ...opts, profile } : opts;
}

/**
 * Whether the site already knows this address, before a signup makes a
 * second account on it: the site's reset form is asked to write, and the
 * inbox says whether it did. Nothing is changed either way — a reset link
 * that nobody opens moves no password.
 */
export async function lookForSiteAccount(o: {
  settings: Settings;
  site: string;
  email: string;
  inbox: string;
  headed?: boolean;
}): Promise<Look> {
  const form = RESET_FORMS[o.site];
  if (!form)
    return {
      verdict: "cannot-tell",
      why: [`no reset page mapped for ${o.site} (src/auth/exists.ts)`],
    };
  const gmail = gmailFor(o.settings);
  const screen = o.headed ? headed : screenOf(o.settings);
  const browser = { ...(await browserFor(o.settings, o.site, screen)), profile: o.site };
  const run = flowRunner(browser, { login: loginFor(o.settings, gmail) });
  return lookForAccount({
    site: o.site,
    email: o.email,
    inbox: o.inbox,
    form,
    ask: async (f, email) =>
      (await run.run(resetMailProbe, { email, form: f }).catch(() => null))?.asked ?? false,
    mail: gmail,
    history: (query) => gmail.search(o.inbox, query),
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

/** One trace sink per process: every traced model call batches through it; null with no endpoint. */
let sink: TraceSink | null | undefined;
export function traceSinkFor(settings: Settings, http = httpClient()): TraceSink | null {
  if (sink !== undefined) return sink;
  sink = settings.otlpEndpoint
    ? otlpSink({
        endpoint: settings.otlpEndpoint,
        headers: settings.otlpHeaders,
        serviceName: settings.otlpServiceName,
        http,
      })
    : null;
  if (sink) flushAtExit(sink);
  return sink;
}

/** A CLI process exits long before the 5 s batch timer fires, so the last spans have to be pushed out by hand. */
function flushAtExit(s: TraceSink): void {
  const flush = () => s.flush();
  process.once("beforeExit", flush);
  process.once("SIGINT", () => void flush().then(() => process.exit(130)));
  process.once("SIGTERM", () => void flush().then(() => process.exit(143)));
}

/** The model behind everything: traced when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, under the daily cap when one is (`LLM_DAILY_TOKENS`). */
/** A model writing a whole file takes minutes, not the 30 s a JSON API gets. */
const LLM_TIMEOUT_MS = 180_000;

export function llmFor(
  settings: Settings,
  http = httpClient({ timeoutMs: LLM_TIMEOUT_MS }),
  onExceeded?: (err: BudgetExceeded) => void,
): BudgetedLlm | Llm | null {
  const raw = makeLlm(
    {
      provider: settings.llmProvider,
      model: settings.llmModel,
      anthropicApiKey: settings.anthropicApiKey,
      openaiApiKey: settings.openaiApiKey,
      openaiBaseUrl: settings.openaiBaseUrl,
      cohereApiKey: settings.cohereApiKey,
    },
    http,
  );
  const traces = raw && traceSinkFor(settings, http);
  const llm = raw && traces ? tracedLlm(raw, traces) : raw;
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
/**
 * The credential store, armed: a read of a canary credential is refused,
 * written to the ledger and, with `notify`, told to a person. `armed:
 * false` is for the operator's own listing; nothing that signs in gets it.
 */
/** The person's accounts and what each is for: the file, else `AUTOBROWSE_ACCOUNTS` (the box). */
export function identitiesFor(settings: Settings): IdentityStore {
  return layeredIdentities(fileIdentities(settings.accountsFile), envIdentities(settings.accounts));
}

export function credentialsFor(
  settings: Settings,
  o: {
    armed?: boolean;
    notify?: CanaryOptions["notify"];
    by?: string;
    /** Off for a pull or a push: the file alone, not the shared store. */
    shared?: boolean;
  } = {},
): CredentialStore {
  const cipher =
    settings.credentialsCipher === "keychain" ? aesGcmCipher(keychainKey(KEYCHAIN)) : plainCipher;
  const file = fileCredentials(settings.credentialsFile, cipher);
  const env = envCredentials(process.env, CRED_ENV);
  // SSM is the truth: reads ask it first and refresh the file, writes land in both.
  // Env baked in at deploy is only the fallback, so a changed password is never stale on the box.
  const store =
    settings.credentialsShared === "ssm" && o.shared !== false
      ? (() => {
          const synced = syncedCredentials(file, envStoreFor(settings), {
            ...CRED_ENV,
            history: credentialHistoryFor(settings),
            onSharedError: (site, err, during) => {
              if (during === "write")
                console.error(
                  `${site}: kept here, not in the shared store (${err instanceof Error ? err.message : String(err)}); autobrowse creds push ${site}`,
                );
            },
          });
          return layeredCredentials([synced, env], synced);
        })()
      : layeredCredentials([env, file]);
  if (o.armed === false) return store;
  return canaryStore(store, {
    audit: auditFor(settings),
    ...(o.notify ? { notify: o.notify } : {}),
    ...(o.by ? { by: o.by } : {}),
  });
}

/** Ships new screenshots to the bucket; null when no bucket is set (they stay local). */
export function shipperFor(
  settings: Settings,
  o: { dry?: boolean } = {},
): (() => Promise<ShipReport>) | null {
  const bucket = settings.shotsBucket;
  if (!bucket) return null;
  const artifacts = expandHome(settings.artifactsDir);
  const store = s3BlobStore({
    bucket,
    region: settings.awsRegion,
    ...(settings.shotsEndpoint ? { endpoint: settings.shotsEndpoint } : {}),
  });
  return () =>
    shipShots({
      roots: [
        { name: "artifacts", dir: artifacts, keep: keepArtifact },
        { name: "recordings", dir: expandHome(settings.recordingsDir), keep: keepRecording },
      ],
      store,
      ledgerFile: join(artifacts, ".shots-shipped.tsv"),
      machine: settings.shotsMachine ?? hostname().replace(/\.local$/, ""),
      ...o,
    });
}

/** Where every secret use is written: next to the credential file, 0600, one JSON line each. */
/** The ledgers live beside the credential file, one hash-chained JSONL each (`autobrowse ledger verify`). */
export function ledgerPath(settings: Settings, name: "audit" | "spend" | "steps"): string {
  return join(dirname(expandHome(settings.credentialsFile)), `${name}.jsonl`);
}

export function stepLedgerFor(settings: Settings): StepLedger {
  return fileStepLedger(ledgerPath(settings, "steps"));
}

export function auditFor(settings: Settings): SecretAudit {
  return fileAudit(ledgerPath(settings, "audit"));
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
    credentials: credentialsFor(settings, {
      by: "login",
      ...(notify ? { notify: (title: string, body: string) => notify(`${title}\n${body}`) } : {}),
    }),
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

/**
 * Where minted secrets go, and are listed from with their expiry: the env
 * store (SSM) in prod; elsewhere the env file in front of it, so a token
 * minted on the laptop is on the box and survives the laptop.
 */
export function sinkFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient({ region: settings.awsRegion })),
): EnvStore {
  const shared = envStoreFor(settings, ssm);
  return settings.secretSink === "ssm"
    ? shared
    : syncedEnvStore(envFileStore(settings.envFile), shared);
}

/**
 * Every state each credential has had: a version per change, one SSM
 * parameter per site under /autobrowse/config/history (one level down, so
 * env listings and the box's deploy never see it). `creds history`, `creds restore`.
 */
export function credentialHistoryFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient({ region: settings.awsRegion })),
): CredentialHistory {
  return ssmCredentialHistory(ssm, `${ENV_STORE_PREFIX}/history`);
}

/** The store `autobrowse env` and prod's sink share: SSM under /autobrowse/config. */
export function envStoreFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient({ region: settings.awsRegion })),
): EnvStore {
  return ssmEnvStore(ssm, ENV_STORE_PREFIX);
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
      t = serviceAccountToken(key, { scopes: delegatedScopes(scopes), subject });
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
  const person = personApprover(settings, gmail, http);
  if (!person) return null;
  return policedApprover(person, {
    policy: spendPolicyFor(settings),
    ledger: spendLedgerFor(settings),
  });
}

/** What the gate decides alone (`SPEND_*`); default: nothing, the person answers every ask. */
export function spendPolicyFor(settings: Settings): SpendPolicy {
  return {
    allow: settings.spendAllow,
    autoYesUnder: settings.spendAutoYesUnder,
    dailyCap: settings.spendDailyCap,
    hardCap: settings.spendHardCap ?? null,
  };
}

/** Every gate decision, next to the credential file and the secret audit. */
export function spendLedgerFor(settings: Settings): SpendLedger {
  return fileSpendLedger(ledgerPath(settings, "spend"));
}

/** The channel a person answers on: phone, then Linq, then email. */
function personApprover(
  settings: Settings,
  gmail: GmailUserClient,
  http: HttpClient,
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
      approve: approverFor(settings, gmailFor(settings)),
      identities: () => identitiesFor(settings).list(),
      kept: () => sink.list(),
      reload: () => sink.all(),
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
      makeCompiledRunObject({
        catalog,
        browser,
        host,
        opts: { guards },
        sink,
        audit: auditFor(settings),
      }),
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
