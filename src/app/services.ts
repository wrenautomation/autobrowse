/** Composition root: settings → clients → workflow deps → Restate services. Secrets stay inside the clients. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SSMClient } from "@aws-sdk/client-ssm";
import {
  aesGcmCipher,
  type CanaryOptions,
  type CredentialHistory,
  type CredentialStore,
  canaryStore,
  chainedFile,
  type EnvEntry,
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
  tailJson,
  versionsFile,
} from "credvault";
import type { Logger } from "pino";
import { fileStepLedger, type StepLedger } from "../agent/ledger.js";
import { type Look, lookForAccount, RESET_FORMS } from "../auth/exists.js";
import { registrable } from "../auth/guard.js";
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
import { CRED_ENV, keychainOf, WALLET_KEYCHAIN } from "../auth/keep.js";
import { type NamedStore, namedStore } from "../auth/roles.js";
import { loginSecrets, type SecretValues } from "../auth/signup.js";
import { fileDoneActs } from "../browser/attempt.js";
import type { Eyes } from "../browser/captcha/index.js";
import { eyesOf } from "../browser/captcha/llm-eyes.js";
import { fileFixes } from "../browser/fixes.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { flowRunner } from "../browser/flow.js";
import { resetMailProbe } from "../browser/flows/reset-mail-probe.js";
import { HUMAN_PACE, type Pace } from "../browser/human/index.js";
import { ownBrowserOf } from "../browser/own.js";
import { SessionPark } from "../browser/park.js";
import { proxyFor } from "../browser/proxy.js";
import {
  llmRepairer,
  llmScreenReader,
  noRepairer,
  rememberingRepairer,
} from "../browser/repair.js";
import { fileScreens } from "../browser/screens.js";
import type { BrowserOptions, FailureRecord } from "../browser/session.js";
import {
  type Channel,
  channels,
  emailChannel,
  forwardChannel,
  linqChannel,
  memoryChannel,
  phoneChannel,
  webhookChannel,
} from "../channels/index.js";
import { cloudflare, verifyCloudflareToken } from "../clients/cloudflare.js";
import { type GmailUserClient, gmailClient } from "../clients/gmail.js";
import { type GoogleAdminClient, googleAdmin } from "../clients/google-admin.js";
import { type HttpClient, httpClient, safeUrl } from "../clients/http.js";
import { type InstantlyClient, instantly } from "../clients/instantly.js";
import { type LinqClient, linqClient } from "../clients/linq.js";
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
import { DO_SERVICE, doService } from "../do/service.js";
import { BROWSER_SERVICE, type BrowserService, browserService } from "../engine/browser-service.js";
import { Unrecoverable } from "../engine/effects.js";
import { parseGuards } from "../engine/guards.js";
import { type HostDeps, makeRunObject } from "../engine/object.js";
import { type RunsRegistry, runsRegistryFor } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import type { ExploreOptions } from "../explore/server.js";
import { askOverChannel } from "../gates/ask.js";
import type { Approver } from "../gates/payment.js";
import {
  fileGrants,
  fileSpendLedger,
  type Grants,
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
import { countedLlm, fileLlmCalls } from "../llm/ledger.js";
import { otlpSink, type TraceSink, tracedLlm, withTrace } from "../llm/trace.js";
import { backboardMemory, type Memory, memoryStore } from "../memory/index.js";
import { type Charge, type ChargeRow, reportCharge } from "../money/charges.js";
import { isDefaultOwner, named, ownerKeys } from "../owner.js";
import { s3BlobStore } from "../shots/s3.js";
import { keepArtifact, keepRecording, type ShipReport, shipShots } from "../shots/ship.js";
import { fileCaps } from "../sites/caps.js";
import {
  accessTokens,
  accountEnv,
  gmailOAuth,
  profileOf,
  SITES_SERVICE,
  type SiteFacade,
  type SitesService,
  sitesFor,
  sitesService,
} from "../sites/index.js";
import { type EventBus, eventBus } from "../ui/bus.js";
import { type WalkInput, type WalkOutput, walkFlow } from "../walks/flow.js";
import { loadWalk, type WalkSpec } from "../walks/spec.js";
import { type BootstrapDeps, bootstrapWorkflow } from "../workflows/bootstrap/index.js";
import {
  type CompiledCatalog,
  compiledCatalog,
  makeCompiledRunObject,
} from "../workflows/compiled.js";
import { type DomainDeps, domainWorkflow } from "../workflows/domain/index.js";
import {
  type InboxActivityDeps,
  inboxActivityWorkflow,
} from "../workflows/inbox-activity/index.js";
import type { Proof } from "../workflows/proof.js";
import { redirectWorkflow } from "../workflows/redirect/index.js";
import { senderDomainWorkflow } from "../workflows/sender-domain/index.js";
import type { Settings } from "./config.js";
import { holding, type Idle, idleTracker } from "./idle.js";
import { awsFor } from "./owner.js";
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
 * "Continue with Google" instead of each site's profile asking again. An
 * app of a provider (Gmail, Drive) uses the provider's profile the same way.
 */
export async function profileForSite(settings: Settings, site: string): Promise<string | null> {
  const store = credentialsFor(settings);
  const name = credentialFor(SITE_LOGINS, site);
  const cred = await store.get(name);
  if (cred?.via) return (await profileOf(store, cred.via, cred.username)) ?? cred.via;
  // An app of a provider (gmail → google) is that account's session: its profile.
  return name !== site ? name : null;
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
  const run = flowRunner(browser, {
    login: loginFor(o.settings, gmail),
    captcha: captchaFor(o.settings),
  });
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
    // `x@<username>` opens the profile of the account it names (`x@wren`).
    profileName: async (name) => (await store.keyOf(name)) ?? name,
    tier: settings.browser,
    cdpUrl: settings.browserCdpUrl ?? null,
    own: ownBrowserOf(settings.ownBrowser, settings.ownBrowserSites),
    proxy: proxyFor(settings.browserProxy, settings.browserProxySites),
    ...(settings.browserTimezone ? { timezone: settings.browserTimezone } : {}),
    ...(settings.browserProxyTimezone ? { proxyTimezone: settings.browserProxyTimezone } : {}),
    profilesDir: settings.profilesDir,
    channel: settings.browserChannel,
    artifactsDir: settings.artifactsDir,
    ...(settings.watchFlows ? { watchFlows: settings.watchFlows } : {}),
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

/** Captcha walls solved before they go to a person: checkboxes always, pictures when the model can see. */
export function captchaFor(
  settings: Settings,
  http?: HttpClient,
): { eyes: Eyes | null; attempts: number } {
  const provider =
    settings.eyesProvider ?? (settings.anthropicApiKey ? "anthropic" : settings.llmProvider);
  const model =
    settings.eyesModel ?? (provider === settings.llmProvider ? settings.llmModel : undefined);
  const llm = llmFor(
    {
      ...settings,
      llmProvider: provider,
      ...(model ? { llmModel: model } : { llmModel: undefined }),
    },
    http,
  );
  return { eyes: llm ? eyesOf(llm) : null, attempts: settings.captchaAttempts };
}

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
  // Every call is counted (the token report); a trace, when there is a collector, sees the same call.
  const counted = raw && countedLlm(raw, fileLlmCalls(llmCallsDirFor(settings)));
  const traces = counted && traceSinkFor(settings, http);
  const llm = counted && traces ? tracedLlm(counted, traces) : counted;
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
export const WORKFLOWS: readonly AnyWorkflow[] = [
  domainWorkflow,
  redirectWorkflow,
  senderDomainWorkflow,
  inboxActivityWorkflow,
  bootstrapWorkflow,
];

/** Hand-written workflows whose deps this machine builds (`autobrowse try`): the domain family. */
export const LOCAL_WORKFLOWS: readonly AnyWorkflow[] = [
  domainWorkflow,
  redirectWorkflow,
  senderDomainWorkflow,
  inboxActivityWorkflow,
];

/** Where compiled workflows live and where the compiler writes; relative imports resolve to the library from there. */
export const COMPILED_DIR = "src/workflows";
export const COMPILED_LIB = "../../index.js";

export interface App {
  services: Array<
    | ReturnType<typeof makeRunObject>
    | RunsRegistry
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

const syncedStores = new Map<string, CredentialStore>();

export function credentialsFor(
  settings: Settings,
  o: {
    armed?: boolean;
    notify?: CanaryOptions["notify"];
    by?: string;
    /** Off for a pull or a push: the file alone, not the shared store. */
    shared?: boolean;
  } = {},
): NamedStore {
  const cipher =
    settings.credentialsCipher === "keychain"
      ? aesGcmCipher(keychainKey(keychainOf(settings.owner)))
      : plainCipher;
  const file = fileCredentials(settings.credentialsFile, cipher);
  const env = envCredentials(process.env, CRED_ENV);
  // SSM is the truth: reads ask it first and refresh the file, writes land in both.
  // Env baked in at deploy is only the fallback, so a changed password is never stale on the box.
  // One synced store per file for the whole process: its cache is what keeps KMS reads down.
  const key = `${settings.owner}|${settings.credentialsFile}|${settings.credentialsCipher}|${settings.awsRegion}`;
  const syncedNow = () => {
    const made = syncedStores.get(key);
    if (made) return made;
    const synced = syncedCredentials(file, envStoreFor(settings), {
      ...CRED_ENV,
      history: credentialHistoryFor(settings),
      // Which SSM version the file holds per site, so the next CLI run trusts the file.
      versions: versionsFile(`${expandHome(settings.credentialsFile)}.versions.json`),
      onSharedError: (site, err, during) => {
        if (during === "write")
          console.error(
            `${site}: kept here, not in the shared store (${err instanceof Error ? err.message : String(err)}); autobrowse creds push ${site}`,
          );
      },
    });
    syncedStores.set(key, synced);
    return synced;
  };
  const store =
    settings.credentialsShared === "ssm" && o.shared !== false
      ? (() => {
          const synced = syncedNow();
          return layeredCredentials([synced, env], synced);
        })()
      : layeredCredentials([env, file]);
  // Addressed by account names (`x`, `x@wren`, `x@<username>`); roles are read below the canary layer.
  if (o.armed === false) return namedStore(store);
  const armed = canaryStore(store, {
    audit: auditFor(settings),
    ...(o.notify ? { notify: o.notify } : {}),
    ...(o.by ? { by: o.by } : {}),
  });
  return namedStore(armed, store);
}

/** Ships new screenshots to the bucket; null when no bucket is set (they stay local). */
export function shipperFor(
  settings: Settings,
  o: { dry?: boolean } = {},
): (() => Promise<ShipReport>) | null {
  const bucket = settings.shotsBucket;
  if (!bucket) return null;
  // An owner's shots are fenced by its IAM session; an S3-compatible store has no such fence.
  if (settings.shotsEndpoint && !isDefaultOwner(settings.owner))
    throw new Error(
      `owner ${settings.owner}: shots ship to S3 only (SHOTS_ENDPOINT has no per-owner scope)`,
    );
  const artifacts = expandHome(settings.artifactsDir);
  const store = s3BlobStore({
    bucket,
    aws: awsFor(settings),
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
      machine: `${ownerKeys(settings.owner).shots}${settings.shotsMachine ?? hostname().replace(/\.local$/, "")}`,
      ...o,
    });
}

/** Where every secret use is written: next to the credential file, 0600, one JSON line each. */
/** The ledgers live beside the credential file, one hash-chained JSONL each (`autobrowse ledger verify`). */
export function ledgerPath(
  settings: Settings,
  name: "audit" | "spend" | "steps" | "charges" | "cards-on-file",
): string {
  return join(dirname(expandHome(settings.credentialsFile)), `${name}.jsonl`);
}

/** The owner's state folder: where the credentials file lives, and every ledger beside it. */
const stateDir = (settings: Settings): string => dirname(expandHome(settings.credentialsFile));

/** Run history (src/runs/log.ts): one folder per site, kept for good. */
export const runsDirFor = (settings: Settings): string => join(stateDir(settings), "runs");

/** Walks built from runs (src/walks): `walks/<site>/<name>.json`. */
export const walksDirFor = (settings: Settings): string => join(stateDir(settings), "walks");

/** Every model call, one file per month (src/llm/ledger.ts). */
export const llmCallsDirFor = (settings: Settings): string => join(stateDir(settings), "llm");

/** Placed secrets a walk asks for: its sites' stored logins, codes from their inboxes; a bare `password` is the walk's own site's. */
function walkSecrets(settings: Settings, spec: WalkSpec): SecretValues {
  const sites = [
    ...new Set([
      spec.site,
      ...spec.secrets.flatMap((s) =>
        s.key.includes(".") ? [s.key.slice(0, s.key.lastIndexOf("."))] : [],
      ),
    ]),
  ];
  const own = loginSecrets(
    credentialsFor(settings),
    sites,
    {},
    {
      codes: { source: codesFor(settings, gmailFor(settings)), since: new Date() },
      phone: ourPhone(settings),
    },
  );
  const bare: Record<string, string> = {
    email: "username",
    username: "username",
    password: "password",
    code: "code",
  };
  return (name) => {
    const field = bare[name];
    return own.secrets(name.includes(".") || !field ? name : `${spec.site}.${field}`);
  };
}

/** A walk by its catalog name, `<site>/walk-<name>`, with the owner's logins and sink; null when there is none. */
export function walkFor(
  settings: Settings,
  flowName: string,
  sink: SecretSink = sinkFor(settings),
): BrowserFlow<WalkInput, WalkOutput> | null {
  const m = /^([a-z0-9][a-z0-9._-]*)(?:@[\w-]+)?\/walk-([a-z][a-z0-9-]*)$/i.exec(flowName);
  if (!m) return null;
  const dir = walksDirFor(settings);
  const spec = loadWalk(dir, m[1] as string, m[2] as string);
  if (!spec) return null;
  return walkFlow(spec, {
    secrets: walkSecrets(settings, spec),
    sink,
    load: (site, name) => loadWalk(dir, site, name),
  });
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
  // The operator's lines (Linq, Twilio) carry only the operator's codes.
  const operators = isDefaultOwner(settings.owner);
  const linq = operators ? linqFor(settings, http) : null;
  if (linq)
    sources.push(messageSource({ kind: "sms", inbox: linq.to, reader: linq.client.reader() }));
  if (operators && settings.twilioAccountSid && settings.twilioAuthToken && settings.twilioNumber)
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

/** The number a site may text us on: the paired phone, else Linq, else Twilio; an owner's own phone only. */
export function ourPhone(settings: Settings, http = httpClient()): string | null {
  const own = phoneFor(settings)?.number ?? null;
  if (!isDefaultOwner(settings.owner)) return own;
  return own ?? linqFor(settings, http)?.to ?? settings.twilioNumber ?? null;
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

/** Linq when the key and our number are set; the operator's number falls back to the paired phone's (never an owner's). */
export function linqFor(
  settings: Settings,
  http = httpClient(),
): { client: LinqClient; to: string } | null {
  const to = settings.linqTo ?? (isDefaultOwner(settings.owner) ? settings.phoneNumber : undefined);
  if (!settings.linqApiKey || !settings.linqNumber || !to) return null;
  return {
    client: linqClient({ apiKey: settings.linqApiKey, from: settings.linqNumber, http }),
    to,
  };
}

/** The runner's pace from settings; `fast` means no delays at all. */
export function paceFor(settings: Settings): Pace | null {
  if (settings.pace === "fast") return null;
  return settings.showPointer ? { ...HUMAN_PACE, showPointer: true } : HUMAN_PACE;
}

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

export function sinkFor(settings: Settings, ssm: SSMClient = ssmFor(settings)): EnvStore {
  const shared = envStoreFor(settings, ssm);
  return settings.secretSink === "ssm"
    ? shared
    : syncedEnvStore(envFileStore(settings.envFile), shared);
}

/**
 * Every state each credential has had: a version per change, one SSM
 * parameter per site under <owner's path>/history (one level down, so
 * env listings and the box's deploy never see it). `creds history`, `creds restore`.
 */
export function credentialHistoryFor(
  settings: Settings,
  ssm: SSMClient = ssmFor(settings),
): CredentialHistory {
  return ssmCredentialHistory(ssm, `${ownerKeys(settings.owner).ssm}/history`);
}

/** Cards and the person's details are the operator's: an owner has neither (designs/2026-09-30-owner-keys.md). */
function operatorOnly(settings: Settings, what: string): void {
  if (!isDefaultOwner(settings.owner))
    throw new Error(`owner ${settings.owner}: ${what} are the operator's; an owner has none`);
}

/**
 * The wallet: the sealed file here (its own keychain item, so a credential
 * read never opens it), backed up to SSM /wallet on every change. macOS only:
 * a machine without the keychain has no cards.
 */
export async function walletFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient(awsFor(settings))),
) {
  operatorOnly(settings, "cards");
  if (process.platform !== "darwin") throw new Error("the wallet lives on the Mac only");
  const { backedUpWallet, fileWallet, ssmWallet } = await import("../money/wallet.js");
  return backedUpWallet(
    fileWallet(expandHome(settings.walletFile), aesGcmCipher(keychainKey(WALLET_KEYCHAIN))),
    ssmWallet(ssm),
  );
}

/** The person's own details, sealed beside the wallet (same keychain item), backed up to SSM /wallet/profiles. */
export async function profilesFor(
  settings: Settings,
  ssm: SSMClient = lazy(() => new SSMClient(awsFor(settings))),
) {
  operatorOnly(settings, "profiles");
  if (process.platform !== "darwin") throw new Error("profiles live on the Mac only");
  const { backedUpProfiles, fileProfiles, ssmProfiles } = await import("../money/profile.js");
  return backedUpProfiles(
    fileProfiles(
      join(dirname(expandHome(settings.walletFile)), "profiles.sealed"),
      aesGcmCipher(keychainKey(WALLET_KEYCHAIN)),
    ),
    ssmProfiles(ssm),
  );
}

/** Explore's card picker: the Mac's wallet under WALLET_DEBIT_HOSTS; elsewhere none (card places are refused). */
export function cardsFor(settings: Settings): ExploreOptions["cards"] {
  if (process.platform !== "darwin" || !isDefaultOwner(settings.owner)) return undefined;
  return async ({ host, label, subscription }) => {
    const { pickCard } = await import("../money/wallet.js");
    const { contactsOf, ownerOf } = await import("../money/profile.js");
    const card = await pickCard(await walletFor(settings), {
      host,
      label,
      subscription,
      policy: { debitHosts: settings.walletDebitHosts },
    });
    // The billing address is the owner's: a checkout's address fields come from the profile.
    const owner = ownerOf(await (await profilesFor(settings)).list(), card.owner);
    return {
      ...card,
      ...(owner?.address ? { billing: owner.address } : {}),
      tell: contactsOf(card, owner),
    };
  };
}

/** The owner's profiles for `place{secret:"profile.<field>"}`: on the Mac only, like the wallet. */
export function profilesForPlace(settings: Settings): ExploreOptions["profiles"] {
  if (process.platform !== "darwin" || !isDefaultOwner(settings.owner)) return undefined;
  return async (id) => {
    const { ownerOf } = await import("../money/profile.js");
    return ownerOf(await (await profilesFor(settings)).list(), id ?? undefined);
  };
}

/** Which card each host was given (brand, kind, last 4 only): a chained ledger, read from its tail. */
export function cardsOnFileFor(settings: Settings): NonNullable<ExploreOptions["cardsOnFile"]> {
  type Row = { at: string; site: string; host: string; card: string };
  const path = ledgerPath(settings, "cards-on-file");
  const ledger = chainedFile<Row>(path);
  return {
    placed: (row) => ledger.append(row),
    async on(host) {
      const rows = await tailJson<Row>(path, 500);
      return rows.findLast((r) => r.host === host)?.card ?? null;
    },
  };
}

/**
 * How a charge is told: a text over the phone channels, an email with the
 * receipt, and a line in charges.jsonl. To the card's own contacts (card,
 * then its owner's profile), else RECEIPTS_TO (else NOTIFY_TO) and this
 * machine's phone.
 */
export function chargesFor(
  settings: Settings,
  gmail: GmailUserClient,
  http = httpClient(),
): NonNullable<ExploreOptions["charges"]> {
  const from = settings.notifyFrom ?? settings.googleAdminUser;
  const receiptsTo = settings.receiptsTo ?? settings.notifyTo;
  const phone = phoneFor(settings);
  const linq = linqFor(settings, http);
  const textsTo = (number?: string) =>
    [
      phone && phoneChannel(number ? { ...phone, number } : phone),
      linq && linqChannel(number ? { ...linq, to: number } : linq),
    ].filter((c): c is Channel => Boolean(c?.note));
  const ledger = chainedFile<ChargeRow>(ledgerPath(settings, "charges"));
  // The merchant's invoice goes to the account's inbox; one that is already the receipts inbox is not read.
  const invoice = async (c: Charge, since: Date) => {
    const cred = await credentialsFor(settings)
      .get(c.site)
      .catch(() => null);
    const inbox = [cred?.username, cred?.codesInbox].find((a) => a?.includes("@"));
    if (!inbox || inbox.toLowerCase() === receiptsTo?.toLowerCase()) return null;
    const domain = registrable(c.host);
    const found = await gmail.whole(
      inbox,
      `after:${Math.floor(since.getTime() / 1000)} {from:${domain} subject:receipt subject:invoice subject:order subject:payment subject:purchase subject:subscription}`,
    );
    return found.find((m) => m.from.toLowerCase().includes(domain)) ?? found[0] ?? null;
  };
  return async (c, r, tell) => {
    const to = tell?.email ?? receiptsTo;
    const texts = textsTo(tell?.phone);
    return (
      await reportCharge(
        {
          ledger,
          invoice,
          ...(texts.length
            ? { text: async (line) => void (await Promise.any(texts.map((t) => t.note?.(line)))) }
            : {}),
          ...(from && to ? { email: (m) => gmail.send({ from, to, ...m }) } : {}),
        },
        c,
        r,
      )
    ).told;
  };
}

/** The store's entries `have` says this process lacks, read by name: never the whole store. */
export async function missingEntries(
  store: EnvStore,
  have: (name: string) => boolean,
): Promise<EnvEntry[]> {
  const names = (await store.list()).map((e) => e.name).filter((n) => !have(n));
  if (!names.length) return [];
  return Object.entries(await store.getMany(names)).map(([name, value]) => ({ name, value }));
}

/** One SSM client per owner and region for the process, made on first use. */
const ssmClients = new Map<string, SSMClient>();
function ssmFor(settings: Settings): SSMClient {
  const key = `${settings.owner}|${settings.awsRegion}`;
  let c = ssmClients.get(key);
  if (!c) {
    c = lazy(() => new SSMClient(awsFor(settings)));
    ssmClients.set(key, c);
  }
  return c;
}

/**
 * The store `autobrowse env` and prod's sink share: SSM under the owner's
 * path (/autobrowse/config for the default owner). One per client and path
 * for the process: it remembers each value by version, and every value read
 * from SSM is a KMS decrypt (billed past 20k a month).
 */
const envStores = new WeakMap<SSMClient, Map<string, EnvStore>>();
export function envStoreFor(settings: Settings, ssm: SSMClient = ssmFor(settings)): EnvStore {
  const path = ownerKeys(settings.owner).ssm;
  let byPath = envStores.get(ssm);
  if (!byPath) {
    byPath = new Map();
    envStores.set(ssm, byPath);
  }
  let store = byPath.get(path);
  if (!store) {
    store = ssmEnvStore(ssm, path);
    byPath.set(path, store);
  }
  return store;
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

/** The Workspace admin API as GOOGLE_ADMIN_USER: domains, users, their names and passwords. */
export function googleAdminFor(
  settings: Settings,
  http = httpClient(),
  scopes: readonly string[] = [
    SCOPES.directoryDomain,
    SCOPES.directoryUser,
    SCOPES.siteVerification,
  ],
): GoogleAdminClient {
  return googleAdmin({
    token: googleTokens(
      settings,
      undefined,
      http,
    )(required(settings.googleAdminUser, "GOOGLE_ADMIN_USER"), scopes),
    http,
  });
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
    grants: spendGrantsFor(settings),
  });
}

/** Yeses the person gave ahead (`spend --grant`), beside the ledgers. */
export function spendGrantsFor(settings: Settings): Grants {
  return fileGrants(join(dirname(expandHome(settings.credentialsFile)), "spend-grants.json"));
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

/** FEED_HOSTS as a list; empty when unset. */
export const feedHostsOf = (settings: Settings): string[] =>
  (settings.feedHosts ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

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
  if (feedHostsOf(settings).length > 0)
    list.push(
      forwardChannel({
        ...(settings.feedToken ? { token: settings.feedToken } : {}),
        log: (line) => console.warn(line),
      }),
    );
  return list;
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

/** What inbox-activity calls: the browser, the inbox's Gmail and plain HTTP. */
export function inboxActivityDepsFor(
  settings: Settings,
  browser: InboxActivityDeps["browser"],
  http = httpClient(),
): InboxActivityDeps {
  return { browser, gmail: gmailFor(settings, http), http };
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
    roster: lazy(() => ssmRosterStore({ param: settings.rosterSsmParam, aws: awsFor(settings) })),
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

export async function buildApp(settings: Settings, log: Logger): Promise<App> {
  const http = httpClient();
  const llm = llmFor(settings, http);
  const memory = memoryFor(settings, http);
  const gmail = gmailFor(settings, http);
  const ssm = ssmFor(settings);

  const list = channelsFor(settings, gmail, http);
  if (list.length === 0) log.warn("no channel configured: gates are visible only in the UI/CLI");
  const bus = eventBus();
  const channel = channels([...list, bus, memoryChannel(memory)]);
  const idle = idleTracker();
  bus.subscribe(() => idle.touch());
  const screen = screenOf(settings);

  const guards = parseGuards(settings.guards);
  const failures: { hook: App["onFailure"] } = { hook: null };
  const park =
    settings.browserKeepMinutes > 0
      ? new SessionPark({
          idleMs: settings.browserKeepMinutes * 60_000,
          max: settings.browserKeepMax,
        })
      : undefined;
  const browser = holding(
    idle,
    flowRunner(browserOptions(settings, screen), {
      ...(park ? { park } : {}),
      onFailure: (record, file) => failures.hook?.(record, file),
      pace: paceFor(settings),
      repairer: rememberingRepairer(memory, llm ? llmRepairer(llm) : noRepairer),
      login: loginFor(settings, gmail),
      captcha: captchaFor(settings, http),
      repairIrreversible: !guards.has("irreversible"),
      fixes: fileFixes(expandHome(settings.fixesFile)),
      learnedScreens: fileScreens(expandHome(settings.screensFile)),
      screenReader: llm ? llmScreenReader(llm) : null,
      done: fileDoneActs(join(expandHome(settings.artifactsDir), "done-acts")),
      onRepair: (r) =>
        log.warn(
          { repair: r },
          `locator ${r.ok ? "repaired" : "not repaired"} in ${r.flow}: ${r.goal}`,
        ),
    }),
  );

  const domainDeps = domainDepsFor(settings, browser, http, ssm);

  const sink = sinkFor(settings, ssm);
  const bootstrapDeps = bootstrapDepsFor(settings, browser, sink, http);

  const host: HostDeps = {
    emit: (e, feed) => channel.deliver(e, feed),
    owner: settings.owner,
    feedHosts: feedHostsOf(settings),
    traced: (trace, fn) => withTrace(trace, fn),
  };
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
      reload: (have) => missingEntries(sink, have),
      caps: fileCaps(expandHome(settings.capsFile)),
    }),
  );
  const late: { doer: Doer | null } = { doer: null };
  return {
    // Every name carries the owner (`sites_<owner>`), so owners share one Restate and never each other's calls.
    services: [
      runsRegistryFor(settings.owner),
      // The browser legs for an orchestrator that owns the API steps (wren); compiled flows by name too.
      browserService(
        { runner: browser, walks: (name) => walkFor(settings, name, sink) },
        named(BROWSER_SERVICE, settings.owner),
      ),
      // The site APIs for the same orchestrator: official shapes, durable over the tunnel.
      sitesService(sites, named(SITES_SERVICE, settings.owner)),
      // One verb for the same orchestrator; the backend wires the doer in after the model exists.
      doService(
        () => (late.doer ? holding(idle, late.doer) : null),
        named(DO_SERVICE, settings.owner),
      ),
      makeRunObject(domainWorkflow, domainDeps, host, { guards }),
      makeRunObject(redirectWorkflow, domainDeps, host, { guards }),
      makeRunObject(senderDomainWorkflow, domainDeps, host, { guards }),
      makeRunObject(inboxActivityWorkflow, inboxActivityDepsFor(settings, browser, http), host, {
        guards,
      }),
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
