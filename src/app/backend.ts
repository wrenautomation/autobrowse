/**
 * The one composition both faces share. `Backend` is the port: what the
 * worker can do (workflows, proofs, prove, heal, compile, outline, runs,
 * agent sessions). The HTTP API (`src/ui/api.ts`, for the SPA) and the CLI
 * are adapters over it; neither builds a proof run or an agent session of
 * its own. Dependency rule: adapters depend on this interface and on
 * `backendFor`; nothing here knows about Hono or commander.
 */
import { join } from "node:path";
import { type HealOutcome, healFailure } from "../agent/heal.js";
import { type AgentSessions, agentSessions } from "../agent/sessions.js";
import { type FlowRunner, flowRunner } from "../browser/flow.js";
import type { FailureRecord } from "../browser/session.js";
import { httpClient } from "../clients/http.js";
import type { Compiled, Outline } from "../compiler/index.js";
import { compile, loadOutline, rerender, saveOutline, writeRendered } from "../compiler/index.js";
import type { SecretSink } from "../deps/sink.js";
import { BROWSER_FLOWS } from "../engine/browser-service.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { type ExploreOptions, type Explorer, startExplore } from "../explore/server.js";
import type { Approver } from "../gates/payment.js";
import { expandHome } from "../google-auth.js";
import type { Llm } from "../llm/types.js";
import type { Recording } from "../recorder/types.js";
import { type SiteFacade, sitesFor } from "../sites/index.js";
import { type EventBus, eventBus } from "../ui/bus.js";
import type { Jobs } from "../ui/jobs.js";
import { type CompiledCatalog, compiledCatalog } from "../workflows/compiled.js";
import type { Proof } from "../workflows/proof.js";
import { proofLine, proveWorkflow, runCompiled, writeProof } from "../workflows/proof.js";
import type { Ingress } from "./client.js";
import type { Settings } from "./config.js";
import { type Screen, screenOf } from "./screen.js";
import {
  type App,
  approverFor,
  browserOptions,
  budgetOf,
  COMPILED_DIR,
  COMPILED_LIB,
  gmailFor,
  llmFor,
  loginFor,
  paceFor,
  sinkFor,
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
): (record: FailureRecord) => Promise<HealOutcome> {
  return (record) =>
    healFailure(record, {
      agent,
      compiledDir: COMPILED_DIR,
      recordingsDir: expandHome(settings.recordingsDir),
      lib: COMPILED_LIB,
      ...(prove ? { prove: async (name: string) => proofLine(await prove(name)) } : {}),
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
): (site: string, port: number, extra?: Pick<ExploreOptions, "tokenFile">) => Promise<Explorer> {
  const approver: Approver | null = approverFor(settings, gmailFor(settings));
  return (site, port, extra = {}) =>
    startExplore({
      site,
      browser: browserOptions(settings, screen),
      recordingsDir: expandHome(settings.recordingsDir),
      port,
      login: loginFor(settings, gmailFor(settings)),
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
  o: { sink?: SecretSink; notify?: (line: string) => Promise<void>; screen?: Screen } = {},
): AgentSessions {
  const open = explorerOpener(settings, o.sink, o.screen);
  return agentSessions({
    llm,
    dir: join(expandHome(settings.recordingsDir), ".sessions"),
    ...(o.notify ? { notify: o.notify } : {}),
    open: (site, port) => open(site, port),
  });
}

/** What a backend is composed from: the worker's `App` has all of it; the CLI makes a local set. */
export type BackendParts = Pick<
  App,
  "catalog" | "browser" | "sink" | "bus" | "workflows" | "proofs" | "sites" | "screen"
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
    pace: paceFor(settings),
  });
  const sink = sinkFor(settings);
  return {
    catalog,
    browser,
    sink,
    screen,
    sites: sitesFor({ catalog, browser, sink, oauthPort: settings.oauthPort }),
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
      })
    : undefined;
  return {
    workflows: app.workflows,
    proofs: app.proofs,
    prove,
    sites: app.sites,
    screen: app.screen,
    ...(agent
      ? { agent, heal: healer(agent, settings, o.proveAfterHeal === false ? undefined : prove) }
      : {}),
    outline: outlineEditor(),
    compile: (rec) => compileRecording(rec, o.llm),
    ingress: o.ingress,
    bus: app.bus,
    recordingsDir: expandHome(settings.recordingsDir),
    artifactsDir: expandHome(settings.artifactsDir),
    ...(o.llm ? { llm: o.llm, budget: () => budgetOf(o.llm) } : {}),
    ...(o.status ? { status: o.status } : {}),
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
      ...(o.proveAfterHeal === undefined ? {} : { proveAfterHeal: o.proveAfterHeal }),
    });
    return { backend, parts };
  };
}
