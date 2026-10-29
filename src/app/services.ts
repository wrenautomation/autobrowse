/** Composition root: settings → clients → workflow deps → Restate services. Secrets stay inside the clients. */

import { dirname, join } from "node:path";
import type { CredentialStore } from "credvault";
import type { Logger } from "pino";
import { fileDoneActs } from "../browser/attempt.js";
import type { FlowRunner } from "../browser/flow.js";
import { flowRunner } from "../browser/flow.js";
import { handsFor } from "../browser/human/index.js";
import { SessionPark } from "../browser/park.js";
import { renderer } from "../browser/render.js";
import {
  llmRepairer,
  llmScreenReader,
  noRepairer,
  rememberingRepairer,
} from "../browser/repair.js";
import type { FailureRecord } from "../browser/session.js";
import { type Channel, channels, memoryChannel } from "../channels/index.js";
import { httpClient } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import type { Doer } from "../do/doer.js";
import { DO_SERVICE, doService } from "../do/service.js";
import { BROWSER_SERVICE, type BrowserService, browserService } from "../engine/browser-service.js";
import { parseGuards } from "../engine/guards.js";
import { type HostDeps, makeRunObject } from "../engine/object.js";
import { type RunsRegistry, runsRegistryFor } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { expandHome } from "../google/auth.js";
import { withTrace } from "../llm/trace.js";
import type { Memory } from "../memory/index.js";
import { modWorkflowRoots } from "../mods/mod.js";
import { named } from "../owner.js";
import { fileSpent } from "../reach/key-ring.js";
import { fileSiteCalls } from "../runs/calls.js";
import { fileCaps } from "../sites/caps.js";
import {
  SITES_SERVICE,
  type SiteFacade,
  type SitesService,
  sitesFor,
  sitesService,
} from "../sites/index.js";
import { fileLimits } from "../sites/limits.js";
import { fileRefusedTokens } from "../sites/refused.js";
import { fileUploadSessions } from "../sites/uploads.js";
import { type EventBus, eventBus } from "../ui/bus.js";
import { bootstrapWorkflow } from "../workflows/bootstrap/index.js";
import {
  type CompiledCatalog,
  compiledCatalog,
  makeCompiledRunObject,
} from "../workflows/compiled.js";
import { domainWorkflow } from "../workflows/domain/index.js";
import { inboxActivityWorkflow } from "../workflows/inbox-activity/index.js";
import { inboxFleetWorkflow } from "../workflows/inbox-fleet/index.js";
import type { Proof } from "../workflows/proof.js";
import { redirectWorkflow } from "../workflows/redirect/index.js";
import { COMPILED_DIR, linkOnce, shippedRoots } from "../workflows/roots.js";
import { senderDomainWorkflow } from "../workflows/sender-domain/index.js";
import { workspaceInboxWorkflow } from "../workflows/workspace-inbox/index.js";
import type { Settings } from "./config.js";
import { type Display, displayOf } from "./display.js";
import { holding, type Idle, idleTracker } from "./idle.js";
import { browserOptions, captchaFor, llmFor, WORKFLOWS } from "./services-browser.js";
import {
  keyAdminFor,
  keyKeeperFor,
  keysDepFor,
  memoryFor,
  missingEntries,
  sinkFor,
  ssmFor,
} from "./services-keys.js";
import { approverFor, channelsFor, feedHostsOf, gmailFor } from "./services-reach.js";
import { loginFor, paceFor, walkFor } from "./services-signin.js";
import {
  auditFor,
  credentialsFor,
  fixesFor,
  identitiesFor,
  loadDataLogins,
  mintedTokensFor,
  modsDirFor,
  noticeFor,
  screensFor,
  sendJournalFor,
  siteCallsDirFor,
  stateDirFor,
} from "./services-state.js";
import {
  bootstrapDepsFor,
  domainDepsFor,
  inboxActivityDepsFor,
  inboxFleetDepsFor,
  workspaceInboxDepsFor,
} from "./services-workflows.js";

export { COMPILED_DIR, COMPILED_LIB } from "../workflows/roots.js";
export {
  browserFor,
  browserOptions,
  budgetOf,
  captchaFor,
  LOCAL_WORKFLOWS,
  llmFor,
  lookForSiteAccount,
  profileForSite,
  traceSinkFor,
  WORKFLOWS,
} from "./services-browser.js";
export {
  envStoreFor,
  keyAdminFor,
  keyKeeperFor,
  keyStoreFor,
  keysDepFor,
  memoryFor,
  missingEntries,
  projectKeysFor,
  sinkFor,
} from "./services-keys.js";
export {
  cardCodeFor,
  cardsFor,
  cardsOnFileFor,
  chargesFor,
  filesFor,
  filesForExplore,
  grantedAheadFor,
  oldPapersDir,
  profilesFor,
  profilesForPlace,
  walletFor,
} from "./services-money.js";
export {
  approverFor,
  channelsFor,
  feedHostsOf,
  gmailFor,
  googleAdminFor,
  googleTokens,
  spendGrantsFor,
  spendLedgerFor,
  spendPolicyFor,
} from "./services-reach.js";
export {
  codesFor,
  devicesFor,
  linqFor,
  loginFor,
  ourPhone,
  overlayOn,
  paceFor,
  phoneFor,
  recordsFile,
  walkFor,
  watchersFor,
} from "./services-signin.js";
export {
  auditFor,
  credentialHistoryFor,
  credentialsFor,
  fixesFor,
  flowRunsDirFor,
  identitiesFor,
  keepSharedOnTimer,
  keepTracesOnTimer,
  ledgerPath,
  llmCallsDirFor,
  loadDataLogins,
  loginsDirFor,
  mintedTokensFor,
  modsDirFor,
  reproofOnTimer,
  runsDirFor,
  screensFor,
  sendJournalFor,
  sendSharedOnTimer,
  shareKnownFor,
  shipperFor,
  siteCallsDirFor,
  stateDirFor,
  stepLedgerFor,
  tracesFor,
  walksDirFor,
} from "./services-state.js";
export {
  bootstrapDepsFor,
  consentsOf,
  domainDepsFor,
  inboxActivityDepsFor,
  inboxFleetDepsFor,
  instantlyFor,
  publicProbe,
  workspaceInboxDepsFor,
} from "./services-workflows.js";

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
  display: Display;
  /** The sealed credential store (env layer first); the Accounts page and `creds` write to it. */
  credentials: CredentialStore;
  /** Set by the host once the agent exists: every failure record goes here (healing). */
  onFailure: ((record: FailureRecord, file: string) => void) | null;
  /** Set by the host once the backend exists: the `do` service runs goals through it (held busy). */
  doer: Doer | null;
}

export async function buildApp(settings: Settings, log: Logger): Promise<App> {
  loadDataLogins(settings);
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
  const display = displayOf(settings);

  const guards = parseGuards(settings.guards);
  const failures: { hook: App["onFailure"] } = { hook: null };
  const park =
    settings.browserKeepMinutes > 0
      ? new SessionPark({
          idleMs: settings.browserKeepMinutes * 60_000,
          max: settings.browserKeepMax,
        })
      : undefined;
  // Only the workers build an app: a parked browser must not outlive its worker.
  if (park)
    for (const [signal, code] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ] as const)
      process.once(signal, () => void park.closeAll().finally(() => process.exit(code)));
  const browserOpts = browserOptions(settings, display);
  const browser = holding(
    idle,
    flowRunner(browserOpts, {
      ...(park ? { park } : {}),
      onFailure: (record, file) => failures.hook?.(record, file),
      pace: paceFor(settings),
      // The worker draws only when asked: its headed runs are real accounts.
      overlay: settings.overlay === "on",
      repairer: rememberingRepairer(memory, llm ? llmRepairer(llm) : noRepairer),
      login: loginFor(settings, gmail),
      captcha: captchaFor(settings, http),
      repairIrreversible: !guards.has("irreversible"),
      fixes: fixesFor(settings),
      learnedScreens: screensFor(settings),
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
  const catalog = compiledCatalog(
    COMPILED_DIR,
    (dir, err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (warned.has(`${dir}\n${message}`)) return;
      warned.add(`${dir}\n${message}`);
      log.warn({ dir, err: message }, "compiled workflow not loaded");
    },
    () => [...shippedRoots(), ...modWorkflowRoots(modsDirFor(settings))],
    linkOnce,
  );
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
      limits: fileLimits(expandHome(settings.limitsFile)),
      spent: fileSpent(join(dirname(expandHome(settings.capsFile)), "spent-keys.json")),
      keys: keysDepFor(settings),
      keeper: keyKeeperFor(settings),
      uploads: fileUploadSessions(join(expandHome(settings.artifactsDir), "uploads")),
      // The fetch ladder's render and exit rungs: profiles `fetch` and `fetch@exit`, parked like flows' browsers.
      // A wall that outlives the challenge wait goes to the flows' captcha solver.
      render: renderer({
        opts: browserOpts,
        ...(park ? { park } : {}),
        captcha: { hands: handsFor(paceFor(settings)), ...captchaFor(settings, http) },
      }),
      started: fileDoneActs(join(expandHome(settings.artifactsDir), "started-calls")),
      walks: (name) => walkFor(settings, name, sink),
      refused: fileRefusedTokens(join(stateDirFor(settings), "refused-tokens.json")),
      minted: mintedTokensFor(settings),
      ...noticeFor(settings),
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
      sitesService(
        sites,
        named(SITES_SERVICE, settings.owner),
        fileSiteCalls(siteCallsDirFor(settings)),
        null,
        {
          wait: { log: (msg, extra) => log.info(extra ?? {}, msg) },
          journal: sendJournalFor(settings),
          keys: keyAdminFor(settings),
        },
      ),
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
      makeRunObject(
        workspaceInboxWorkflow,
        workspaceInboxDepsFor(settings, browser, sites, sink, http, ssm),
        host,
        { guards },
      ),
      makeRunObject(bootstrapWorkflow, bootstrapDeps, host, { guards }),
      makeRunObject(inboxFleetWorkflow, inboxFleetDepsFor(settings, http, ssm), host, { guards }),
      // Every compiled flow, present and future, runs under this one object.
      makeCompiledRunObject({
        catalog,
        browser,
        host,
        opts: { guards },
        sink,
        keys: keyKeeperFor(settings),
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
    display,
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
