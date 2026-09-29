/**
 * The one composition both faces share. `Backend` is the port: what the
 * worker can do (workflows, proofs, prove, heal, compile, outline, runs,
 * agent sessions). The HTTP API (`src/ui/api.ts`, for the SPA) and the CLI
 * are adapters over it; neither builds a proof run or an agent session of
 * its own. Dependency rule: adapters depend on this interface and on
 * `backendFor`; nothing here knows about Hono or commander.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Scope } from "../access/keys.js";
import { type HealOutcome, healFailure } from "../agent/heal.js";
import { type AgentSessions, agentSessions } from "../agent/sessions.js";
import { type Accounts, accountsOf } from "../auth/accounts.js";
import { type LedgerWindow, ledgerSince } from "../auth/ledger.js";
import { SITE_LOGINS } from "../auth/sites.js";
import { type FlowRunner, flowRunner } from "../browser/flow.js";
import type { FailureRecord } from "../browser/session.js";
import type { Compiled, FinishOutcome, Outline } from "../compiler/index.js";
import {
  checkCompiled,
  compile,
  finish,
  format,
  loadOutline,
  rerender,
  saveOutline,
  writeRendered,
} from "../compiler/index.js";
import type { SecretSink } from "../deps/sink.js";
import type { Ability } from "../do/catalog.js";
import type { Doer } from "../do/doer.js";
import { filePicks } from "../do/memory.js";
import { type DoerParts, doerFor, type Verb } from "../do/wire.js";
import type { RunEvent } from "../engine/events.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import {
  type ExploreOptions,
  type Explorer,
  journalFileFor,
  startExplore,
} from "../explore/server.js";
import type { Approver } from "../gates/payment.js";
import { expandHome } from "../google-auth.js";
import type { Llm } from "../llm/types.js";
import { loadRecording } from "../recorder/store.js";
import type { Recording } from "../recorder/types.js";
import { fileCaps } from "../sites/caps.js";
import { type SiteFacade, sitesFor } from "../sites/index.js";
import { type EventBus, eventBus } from "../ui/bus.js";
import type { Jobs } from "../ui/jobs.js";
import { type CompiledCatalog, compiledCatalog } from "../workflows/compiled.js";
import type { Proof } from "../workflows/proof.js";
import { proofLine, proveWorkflow, writeProof } from "../workflows/proof.js";
import type { Ingress } from "./client.js";
import type { Settings } from "./config.js";
import { needsContextFor, type Owed, owedOf, type Policy, policyOf } from "./owed.js";
import { type Screen, screenOf } from "./screen.js";
import {
  type App,
  approverFor,
  auditFor,
  browserFor,
  browserOptions,
  budgetOf,
  COMPILED_DIR,
  COMPILED_LIB,
  captchaFor,
  cardsFor,
  cardsOnFileFor,
  chargesFor,
  credentialsFor,
  gmailFor,
  identitiesFor,
  llmFor,
  loginFor,
  missingEntries,
  paceFor,
  sinkFor,
  spendLedgerFor,
  stepLedgerFor,
  WORKFLOWS,
} from "./services.js";
import type { Status } from "./status.js";

export interface Backend {
  /** The workflows a run may name; a function when compiled ones come and go without a restart. */
  workflows: readonly AnyWorkflow[] | (() => Promise<readonly AnyWorkflow[]>);
  /** Compiled workflows' proof runs by name; a name absent here is hand-written. */
  proofs?: Record<string, Proof | null> | (() => Promise<Record<string, Proof | null>>);
  /** Run a compiled workflow once as its proof and keep it; absent when there is no browser here. */
  prove?(workflow: string, plan?: Record<string, unknown>): Promise<Proof>;
  /** Heal a failed compiled step from its failure record: agent finishes it, step rewritten, proven. */
  heal?(record: FailureRecord): Promise<HealOutcome>;
  /** A compiled workflow's editable outline: read it, or save an edit and re-render the module. */
  outline?: {
    load(name: string): Promise<Outline | null>;
    save(name: string, outline: Outline): Promise<Compiled>;
  };
  compile(rec: Recording): Promise<Compiled>;
  /** A model finishes a compiled workflow (plan inputs, send gate, proof read) inside the typecheck+test loop; absent without a model. */
  finish?(
    name: string,
    o?: { brief?: string; rounds?: number; onRound?: FinishRound },
  ): Promise<FinishOutcome>;
  /** Where prove/heal run; one per process, injectable for tests. */
  jobs?: Jobs;
  ingress: Ingress;
  bus: EventBus;
  recordingsDir: string;
  artifactsDir: string;
  /** Agent sessions (explore by model with play/pause); absent when no model is configured. */
  agent?: AgentSessions;
  /** The model the evaluator uses; absent when none is configured. */
  llm?: Llm;
  /** What the worker is made of (vendor names, channels); shown on the Status page. */
  status?: Status;
  /** Today's model spend against the cap, read live; absent = as the status says. */
  budget?(): Status["budget"];
  /** Sites served under their official API's shape, with their key/token setup. */
  sites?: SiteFacade;
  /** The one live setting: headed or headless for the next browser. */
  screen: Screen;
  /** Stored sign-ins by site (never the values), add/change, prove with a sign-in. */
  accounts: Accounts;
  /** One verb over everything: route a goal to what does it, or have the agent build it. */
  do: Doer;
  /** What `do` can pick from right now. */
  abilities(): Promise<Ability[]>;
  /** `do` as an agent key sees it: its catalog cut to its scope, each leg checked (`access/keys`). */
  doAs?(scope: Scope): Verb;
  /** Where secrets went and what the payment gate decided since a time (never a value). */
  ledger?(since: Date): Promise<LedgerWindow>;
  /** What only the person can give, each row with its check; done-marks for decisions. */
  owed?: Owed;
  /** Which account is for what, and how ready each is. */
  policy?: Policy;
}

/** The port allows a value or a loader for these; every face reads them the same way. */
export const workflowsOf = async (b: Backend): Promise<readonly AnyWorkflow[]> =>
  typeof b.workflows === "function" ? b.workflows() : b.workflows;
export const proofsOf = async (b: Backend): Promise<Record<string, Proof | null>> =>
  typeof b.proofs === "function" ? b.proofs() : (b.proofs ?? {});

/** One proof run of a compiled flow, kept beside it; the catalog reads it back on the next listing. */
export async function proveCompiled(
  catalog: CompiledCatalog,
  browser: FlowRunner,
  name: string,
  plan?: Record<string, unknown>,
): Promise<Proof> {
  const found = await catalog.get(name);
  if (!found) throw new Error(`compiled workflow ${name} did not load`);
  const proof = await proveWorkflow(found.workflow, browser, plan ? { plan } : {});
  await writeProof(found.dir, proof);
  return proof;
}

/** Recording → outline + module, written where the catalog loads from (on the Runs page at once). */
export async function compileRecording(rec: Recording, llm: Llm | null): Promise<Compiled> {
  const out = await compile(rec, { llm, lib: COMPILED_LIB });
  const dir = join(COMPILED_DIR, out.outline.name);
  await writeRendered(dir, out);
  await saveOutline(dir, out.outline);
  return out;
}

/** The hand-finished workflow every model finish imitates; null when it is not checked out here. */
const EXEMPLAR = "aws-port25-request";

async function exemplarFor(name: string): Promise<{ module: string; test: string } | null> {
  if (name === EXEMPLAR) return null;
  const dir = join(COMPILED_DIR, EXEMPLAR);
  try {
    const [module, test] = await Promise.all([
      readFile(join(dir, "index.ts"), "utf8"),
      readFile(join(dir, "index.test.ts"), "utf8"),
    ]);
    return { module, test };
  } catch {
    return null;
  }
}

/** The model's last mile on a compiled workflow, judged by tsc and vitest; the files stay as they were when it gives up. */
export type FinishRound = (round: number, errors: string) => void;

export async function finishCompiled(
  name: string,
  llm: Llm,
  o: { brief?: string; rounds?: number; onRound?: FinishRound } = {},
): Promise<FinishOutcome> {
  return finish({
    llm,
    dir: join(COMPILED_DIR, name),
    check: (dir) => checkCompiled(dir),
    exemplar: await exemplarFor(name),
    format,
    ...(o.brief ? { brief: o.brief } : {}),
    ...(o.rounds ? { rounds: o.rounds } : {}),
    ...(o.onRound ? { onRound: o.onRound } : {}),
  });
}

/** The outline beside a compiled module is its edit surface; saving re-renders through the heal's path. */
export const outlineEditor = (): NonNullable<Backend["outline"]> => ({
  load: (name) => loadOutline(join(COMPILED_DIR, name)).catch(() => null),
  save: (name, outline) => rerender(join(COMPILED_DIR, name), outline, { lib: COMPILED_LIB }),
});

/** A heal: the agent finishes the failed step, the outline is spliced, then (when given) proven. */
export function healer(
  agent: AgentSessions,
  settings: Settings,
  prove?: (name: string) => Promise<Proof>,
  llm?: Llm | null,
): (record: FailureRecord) => Promise<HealOutcome> {
  return (record) =>
    healFailure(record, {
      agent,
      compiledDir: COMPILED_DIR,
      recordingsDir: expandHome(settings.recordingsDir),
      lib: COMPILED_LIB,
      check: (dir: string) => checkCompiled(dir),
      ...(prove ? { prove: async (name: string) => proofLine(await prove(name)) } : {}),
      ...(llm
        ? {
            finish: (name: string, step: string) =>
              finishCompiled(name, llm, {
                brief: `step "${step}" was just rewritten from a heal`,
              }),
          }
        : {}),
    });
}

/**
 * How every face opens an explore server: one browser on a site, the worker's
 * login, a person's pace, its secret sink and payment approver. The CLI's
 * `explore`, the MCP server, the agent's sessions and a heal all go through here.
 */
export function explorerOpener(
  settings: Settings,
  sink: SecretSink = sinkFor(settings),
  screen: Screen = screenOf(settings),
): (
  site: string,
  port: number,
  extra?: Pick<
    ExploreOptions,
    "tokenFile" | "secrets" | "secretHosts" | "idleMinutes" | "journalFile"
  > & {
    /** false: a wall on `open` stays a wall (a signup page must not sign in as a stored account). */
    signIn?: boolean;
  },
) => Promise<Explorer> {
  const approver: Approver | null = approverFor(settings, gmailFor(settings));
  const cards = cardsFor(settings);
  return async (site, port, { signIn = true, ...extra } = {}) =>
    startExplore({
      site,
      browser: await browserFor(settings, site, screen),
      recordingsDir: expandHome(settings.recordingsDir),
      port,
      ...(signIn ? { login: loginFor(settings, gmailFor(settings)) } : {}),
      captcha: captchaFor(settings),
      audit: auditFor(settings),
      ...(cards ? { cards, cardsOnFile: cardsOnFileFor(settings) } : {}),
      charges: chargesFor(settings, gmailFor(settings)),
      pace: paceFor(settings), // an agent browses at a person's pace: sites watch for the other kind
      sink,
      ...(approver ? { approve: approver } : {}),
      ...extra,
    });
}

/** Agent sessions over that opener; session views persist under the recordings dir. */
export function agentFor(
  settings: Settings,
  llm: Llm,
  o: {
    sink?: SecretSink;
    notify?: (line: string) => Promise<void>;
    screen?: Screen;
    emit?: (event: RunEvent) => Promise<void>;
  } = {},
): AgentSessions {
  const open = explorerOpener(settings, o.sink, o.screen);
  return agentSessions({
    llm,
    dir: join(expandHome(settings.recordingsDir), ".sessions"),
    ledger: stepLedgerFor(settings),
    ...(o.notify ? { notify: o.notify } : {}),
    ...(o.emit ? { emit: o.emit } : {}),
    // One journal per session: a pick-up after a crash saves the acts before it too.
    open: (site, port, session) =>
      open(
        site,
        port,
        session
          ? { journalFile: journalFileFor(expandHome(settings.recordingsDir), site, session) }
          : {},
      ),
  });
}

/** What a backend is composed from: the worker's `App` has all of it; the CLI makes a local set. */
export type BackendParts = Pick<
  App,
  | "catalog"
  | "browser"
  | "sink"
  | "bus"
  | "workflows"
  | "proofs"
  | "sites"
  | "screen"
  | "credentials"
>;

/**
 * The CLI's parts: no Restate, memory or channels — the catalog on disk, one
 * browser, the configured sink. `try`, `heal`, `compile` and `workflows` run
 * on these in-process.
 */
export function localParts(settings: Settings, o: { headless?: boolean } = {}): BackendParts {
  const catalog = compiledCatalog(COMPILED_DIR);
  const gmail = gmailFor(settings);
  const screen = o.headless === undefined ? screenOf(settings) : { headless: o.headless };
  const browser = flowRunner(browserOptions(settings, screen), {
    login: loginFor(settings, gmail),
    captcha: captchaFor(settings),
    pace: paceFor(settings),
  });
  const sink = sinkFor(settings);
  return {
    catalog,
    browser,
    sink,
    screen,
    sites: sitesFor({
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
    credentials: credentialsFor(settings),
    bus: eventBus(),
    workflows: async () => [...WORKFLOWS, ...(await catalog.list()).map((c) => c.workflow)],
    proofs: () => catalog.proofs(),
  };
}

export interface BackendOptions {
  /** The worker's model, or none: then compile is deterministic-only and there is no agent, heal or evaluator. */
  llm: Llm | null;
  ingress: Ingress;
  /** Where a person hears from the agent (session notes, heal lines); absent = silent. */
  notify?: (line: string) => Promise<void>;
  status?: Status;
  /** A heal ends with a proof run unless told not to (CLI `heal --no-prove`). */
  proveAfterHeal?: boolean;
  /** False for a backend with no Restate behind its ingress (the CLI's local set). */
  registry?: boolean;
}

/**
 * The one composition. Every face gets its `Backend` from here, so a heal
 * from the UI, a heal from the CLI and an auto-heal after a failed run are
 * the same code with the same catalog, browser, sink and approver behind it.
 */
export function backendFor(settings: Settings, app: BackendParts, o: BackendOptions): Backend {
  const prove = (name: string, plan?: Record<string, unknown>) =>
    proveCompiled(app.catalog, app.browser, name, plan);
  const agent = o.llm
    ? agentFor(settings, o.llm, {
        sink: app.sink,
        screen: app.screen,
        ...(o.notify ? { notify: o.notify } : {}),
        // Sessions are rows in the Runs registry and on the live feed, like any run.
        emit: async (event) => {
          await Promise.allSettled([
            app.bus.deliver(event),
            o.registry === false ? Promise.resolve() : o.ingress.registry().record(event),
          ]);
        },
      })
    : undefined;
  const recordingsDir = expandHome(settings.recordingsDir);
  const verbParts: DoerParts = {
    llm: o.llm,
    catalog: app.catalog,
    browser: app.browser,
    sink: app.sink,
    ...(app.sites ? { sites: app.sites } : {}),
    ...(agent ? { agent } : {}),
    memory: filePicks(join(recordingsDir, ".do-picks.json")),
    compile: async (name) => ({
      workflow: (await compileRecording(await loadRecording(recordingsDir, name), o.llm)).outline
        .name,
    }),
  };
  const verb = doerFor(verbParts);
  return {
    workflows: app.workflows,
    proofs: app.proofs,
    prove,
    sites: app.sites,
    do: verb,
    abilities: verb.abilities,
    doAs: (scope) => doerFor({ ...verbParts, scope }),
    screen: app.screen,
    accounts: accountsOf({ store: app.credentials, logins: SITE_LOGINS, runner: app.browser }),
    ...(agent
      ? {
          agent,
          heal: healer(agent, settings, o.proveAfterHeal === false ? undefined : prove, o.llm),
        }
      : {}),
    outline: outlineEditor(),
    compile: (rec) => compileRecording(rec, o.llm),
    ...(o.llm ? { finish: (name, opts) => finishCompiled(name, o.llm as Llm, opts) } : {}),
    ingress: o.ingress,
    bus: app.bus,
    recordingsDir,
    artifactsDir: expandHome(settings.artifactsDir),
    ...(o.llm ? { llm: o.llm, budget: () => budgetOf(o.llm) } : {}),
    ...(o.status ? { status: o.status } : {}),
    ledger: (since) => ledgerSince(auditFor(settings), spendLedgerFor(settings), since),
    owed: owedOf(needsContextFor(settings)),
    policy: policyOf(settings),
  };
}

export interface LocalOptions {
  headless?: boolean;
  /** false: no model pass (compile is template-only; no agent, no heal). */
  llm?: boolean;
  proveAfterHeal?: boolean;
}
export type LocalBackend = (o?: LocalOptions) => { backend: Backend; parts: BackendParts };

/**
 * The CLI's backend: the same port the UI's HTTP API serves, composed from
 * in-process parts, so `workflows`, `try --prove`, `heal` and `compile` are
 * the worker's own code and not a second copy of it.
 */
export function localBackend(settings: Settings, ingress: Ingress): LocalBackend {
  return (o = {}) => {
    const parts = localParts(settings, o);
    const backend = backendFor(settings, parts, {
      llm: o.llm === false ? null : llmFor(settings),
      ingress,
      // The CLI's sessions are its own; the registry is the worker's to keep.
      registry: false,
      ...(o.proveAfterHeal === undefined ? {} : { proveAfterHeal: o.proveAfterHeal }),
    });
    return { backend, parts };
  };
}
