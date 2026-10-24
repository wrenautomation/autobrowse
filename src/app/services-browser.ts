/** The browser and the model: profiles, the runner's options, the traced LLM, the hand-written workflow lists. */
import { join } from "node:path";
import { type Look, lookForAccount, RESET_FORMS } from "../auth/exists.js";
import { credentialFor, SITE_LOGINS } from "../auth/index.js";
import type { Eyes } from "../browser/captcha/index.js";
import { eyesOf } from "../browser/captcha/llm-eyes.js";
import { egressOf } from "../browser/egress.js";
import { flowRunner } from "../browser/flow.js";
import { resetMailProbe } from "../browser/flows/reset-mail-probe.js";
import { ownBrowserOf } from "../browser/own.js";
import type { BrowserOptions } from "../browser/session.js";
import { type HttpClient, httpClient } from "../clients/http.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { expandHome } from "../google/auth.js";
import { type BudgetExceeded, type BudgetedLlm, budgetedLlm, fileLedger } from "../llm/budget.js";
import { type Llm, makeLlm } from "../llm/index.js";
import { fileLlmCalls } from "../llm/ledger.js";
import { otlpSink, type TraceSink, tracedLlm } from "../llm/trace.js";
import { profileOf } from "../sites/index.js";
import { bootstrapWorkflow } from "../workflows/bootstrap/index.js";
import { domainWorkflow } from "../workflows/domain/index.js";
import { inboxActivityWorkflow } from "../workflows/inbox-activity/index.js";
import { inboxFleetWorkflow } from "../workflows/inbox-fleet/index.js";
import { redirectWorkflow } from "../workflows/redirect/index.js";
import { senderDomainWorkflow } from "../workflows/sender-domain/index.js";
import { workspaceInboxWorkflow } from "../workflows/workspace-inbox/index.js";
import type { Settings } from "./config.js";
import { type Display, displayOf, headed } from "./display.js";
import { gmailFor } from "./services-reach.js";
import { loginFor } from "./services-signin.js";
import { credentialsFor, llmCallsDirFor } from "./services-state.js";

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
  display?: Display,
): Promise<BrowserOptions> {
  const opts = display ? browserOptions(settings, display) : browserOptions(settings);
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
  const display = o.headed ? headed : displayOf(o.settings);
  const browser = { ...(await browserFor(o.settings, o.site, display)), profile: o.site };
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
  display: Display = displayOf(settings),
): BrowserOptions {
  const store = credentialsFor(settings);
  return {
    // Read when a browser opens, so the switch applies to the next one.
    get headless() {
      return display.headless;
    },
    // The site's account's passkeys ride along in its session.
    passkeys: async (site) => {
      return (await store.get(credentialFor(SITE_LOGINS, site)))?.passkeys ?? [];
    },
    // `x@<username>` opens the profile of the account it names (`x@wren`); so does a
    // site that signs in as one account (google-admin as `google@admin`).
    profileName: async (name) => {
      const as = credentialFor(SITE_LOGINS, name);
      return (await store.keyOf(as.includes("@") ? as : name)) ?? name;
    },
    providerProfile: (site) => profileForSite(settings, site),
    tier: settings.browser,
    cdpUrl: settings.browserCdpUrl ?? null,
    own: ownBrowserOf(settings.ownBrowser, settings.ownBrowserSites),
    // Exits are named in the env (`EGRESS_SITES`, `EGRESS_<NAME>`), so read there.
    egress: egressOf((n) => process.env[n], {
      signsIn: (site) => SITE_LOGINS.some((l) => l.site === site),
    }),
    ...(settings.browserTimezone ? { timezone: settings.browserTimezone } : {}),
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
    // Every call is counted (the token report); a trace, when there is a collector, sees the same call.
    { calls: fileLlmCalls(llmCallsDirFor(settings)) },
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
export const WORKFLOWS: readonly AnyWorkflow[] = [
  domainWorkflow,
  redirectWorkflow,
  senderDomainWorkflow,
  inboxActivityWorkflow,
  workspaceInboxWorkflow,
  bootstrapWorkflow,
  inboxFleetWorkflow,
];

/** Hand-written workflows whose deps this machine builds (`autobrowse try`): the domain family. */
export const LOCAL_WORKFLOWS: readonly AnyWorkflow[] = [
  domainWorkflow,
  redirectWorkflow,
  senderDomainWorkflow,
  inboxActivityWorkflow,
  workspaceInboxWorkflow,
  inboxFleetWorkflow,
];
