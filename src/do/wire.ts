/**
 * The verb from a worker's parts: catalog, browser, sink, the site facade,
 * the agent. Every catalog it reads (sites, flows, logins) is an option with
 * the built-in as default, so a library caller can hand a narrower world.
 */
import {
  allowsSite,
  allowsTool,
  allowsWorkflow,
  can,
  OPERATOR,
  type Scope,
} from "../access/keys.js";
import type { AgentSessions } from "../agent/sessions.js";
import type { SiteLogin } from "../auth/login.js";
import { SITE_LOGINS } from "../auth/sites.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { localShell, type Shell } from "../deps/shell.js";
import type { SecretSink } from "../deps/sink.js";
import { BROWSER_FLOWS } from "../engine/browser-service.js";
import type { Llm } from "../llm/types.js";
import type { SiteFacade } from "../sites/facade.js";
import { SITES } from "../sites/index.js";
import type { SiteApi } from "../sites/types.js";
import type { CompiledCatalog } from "../workflows/compiled.js";
import { runCompiled } from "../workflows/proof.js";
import { type Ability, abilitiesOf } from "./catalog.js";
import { DoError, type Doer, doer } from "./doer.js";
import type { PickMemory } from "./memory.js";
import { binPresence, runTool, TOOLS, type Tool, ToolInputError, toolAbilities } from "./tools.js";

export interface DoerParts {
  /** None: exact-name asks still route; anything else is 501. */
  llm: Llm | null;
  catalog: CompiledCatalog;
  browser: FlowRunner;
  sink: SecretSink;
  /** The site facade; none = no site abilities. */
  sites?: SiteFacade;
  /** The site modules behind the facade (request shapes); the built-in list unless said. */
  siteApis?: readonly SiteApi[];
  /** Hand-written legs by `site/name`; the built-in catalog unless said. */
  flows?: Record<string, BrowserFlow<never, unknown>>;
  /** Where the agent can work signed in; the built-in logins unless said. */
  logins?: readonly SiteLogin[];
  /** The agent, when a model is there; none = nothing new gets built. */
  agent?: AgentSessions;
  /** Compile the recording saved under `name`; none = the agent's run is saved but not compiled. */
  compile?: (name: string) => Promise<{ workflow: string }>;
  /** Command-line tools; the built-in list unless said, `[]` for none. */
  tools?: readonly Tool[];
  /** Where tools run; the local shell unless said. */
  shell?: Shell;
  /** Earlier picks for the model; none = every ask starts cold. */
  memory?: PickMemory;
  /**
   * An agent key's scope: the catalog shows only what it may use, and each
   * leg checks again before it runs. No agent sessions (nothing new built)
   * unless the scope may `agent`. The operator's when absent.
   */
  scope?: Scope;
  /** The owner this process serves; a request for another is refused. The default owner when absent. */
  owner?: string;
}

/** Whether a scope may run this ability: its site (default account), workflow or tool. */
export function mayUse(scope: Scope, a: Ability): boolean {
  if (scope.operator) return true;
  if (a.kind === "workflow") return allowsWorkflow(scope, a.name);
  if (a.kind === "tool") return allowsTool(scope, a.name);
  return a.site !== null && allowsSite(scope, a.site);
}

export interface Verb extends Doer {
  /** What `do` can pick from right now. */
  abilities(): Promise<Ability[]>;
}

export function doerFor(p: DoerParts): Verb {
  const scope = p.scope ?? OPERATOR;
  const refuse = (what: string) => new DoError(403, `this key may not use ${what}`);
  const flows = p.flows ?? BROWSER_FLOWS;
  const tools = p.tools ?? TOOLS;
  const shell = p.shell ?? localShell();
  const present = binPresence(shell);
  const all = async (): Promise<Ability[]> => {
    const has = new Map(
      await Promise.all(tools.map(async (t) => [t.bin, await present(t.bin)] as const)),
    );
    return [
      ...abilitiesOf({
        ...(p.sites ? { sites: { apis: p.siteApis ?? SITES, rows: await p.sites.list() } } : {}),
        workflows: (await p.catalog.list()).map((c) => c.workflow),
        flows: Object.keys(flows),
      }),
      ...toolAbilities(tools, (bin) => has.get(bin) ?? false),
    ];
  };
  const abilities = async (): Promise<Ability[]> =>
    scope.operator ? all() : (await all()).filter((a) => mayUse(scope, a));
  const agentOk = scope.operator || can(scope, "agent");
  const verb = doer({
    llm: p.llm,
    abilities,
    sites: async () =>
      (p.logins ?? SITE_LOGINS).map((l) => l.site).filter((s) => allowsSite(scope, s)),
    callSite: (site, method, path, input) => {
      if (!allowsSite(scope, site)) throw refuse(site);
      if (!p.sites) throw new Error("no site apis here");
      return p.sites.call(site, method, path, input);
    },
    runWorkflow: async (name, plan) => {
      if (!allowsWorkflow(scope, name)) throw refuse(name);
      const found = await p.catalog.get(name);
      if (!found) throw new Error(`no compiled workflow named ${name}`);
      return runCompiled(found.workflow, p.browser, { plan, sink: p.sink });
    },
    runFlow: async (name, input) => {
      if (!allowsSite(scope, name.split("/")[0] ?? name)) throw refuse(name);
      const flow = flows[name];
      if (!flow) throw new Error(`no flow named ${name}`);
      return p.browser.run(flow as never, input);
    },
    runTool: async (name, input) => {
      if (!allowsTool(scope, name)) throw refuse(name);
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool named ${name}`);
      try {
        return await runTool(tool, input, shell);
      } catch (err) {
        if (err instanceof ToolInputError) throw new DoError(400, err.message);
        throw err;
      }
    },
    ...(p.memory ? { memory: p.memory } : {}),
    ...(p.owner ? { owner: p.owner } : {}),
    ...(p.agent && agentOk ? { agent: p.agent } : {}),
    ...(p.compile && agentOk ? { compile: p.compile } : {}),
  });
  return { do: (req) => verb.do(req), abilities };
}
