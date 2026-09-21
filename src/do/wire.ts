/**
 * The verb from a worker's parts: catalog, browser, sink, the site facade,
 * the agent. Every catalog it reads (sites, flows, logins) is an option with
 * the built-in as default, so a library caller can hand a narrower world.
 */
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
}

export interface Verb extends Doer {
  /** What `do` can pick from right now. */
  abilities(): Promise<Ability[]>;
}

export function doerFor(p: DoerParts): Verb {
  const flows = p.flows ?? BROWSER_FLOWS;
  const tools = p.tools ?? TOOLS;
  const shell = p.shell ?? localShell();
  const present = binPresence(shell);
  const abilities = async (): Promise<Ability[]> => {
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
  const verb = doer({
    llm: p.llm,
    abilities,
    sites: async () => (p.logins ?? SITE_LOGINS).map((l) => l.site),
    callSite: (site, method, path, input) => {
      if (!p.sites) throw new Error("no site apis here");
      return p.sites.call(site, method, path, input);
    },
    runWorkflow: async (name, plan) => {
      const found = await p.catalog.get(name);
      if (!found) throw new Error(`no compiled workflow named ${name}`);
      return runCompiled(found.workflow, p.browser, { plan, sink: p.sink });
    },
    runFlow: (name, input) => {
      const flow = flows[name];
      if (!flow) throw new Error(`no flow named ${name}`);
      return p.browser.run(flow as never, input);
    },
    runTool: async (name, input) => {
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
    ...(p.agent ? { agent: p.agent } : {}),
    ...(p.compile ? { compile: p.compile } : {}),
  });
  return { do: (req) => verb.do(req), abilities };
}
