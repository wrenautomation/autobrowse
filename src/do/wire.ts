/**
 * The verb from a worker's parts: catalog, browser, sink, the site facade,
 * the agent. Every catalog it reads (sites, flows, logins) is an option with
 * the built-in as default, so a library caller can hand a narrower world.
 */
import type { AgentSessions } from "../agent/sessions.js";
import type { SiteLogin } from "../auth/login.js";
import { SITE_LOGINS } from "../auth/sites.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import type { SecretSink } from "../deps/sink.js";
import { BROWSER_FLOWS } from "../engine/browser-service.js";
import type { Llm } from "../llm/types.js";
import type { SiteFacade } from "../sites/facade.js";
import { SITES } from "../sites/index.js";
import type { SiteApi } from "../sites/types.js";
import type { CompiledCatalog } from "../workflows/compiled.js";
import { runCompiled } from "../workflows/proof.js";
import { type Ability, abilitiesOf } from "./catalog.js";
import { type Doer, doer } from "./doer.js";

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
}

export interface Verb extends Doer {
  /** What `do` can pick from right now. */
  abilities(): Promise<Ability[]>;
}

export function doerFor(p: DoerParts): Verb {
  const flows = p.flows ?? BROWSER_FLOWS;
  const abilities = async (): Promise<Ability[]> =>
    abilitiesOf({
      ...(p.sites ? { sites: { apis: p.siteApis ?? SITES, rows: await p.sites.list() } } : {}),
      workflows: (await p.catalog.list()).map((c) => c.workflow),
      flows: Object.keys(flows),
    });
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
    ...(p.agent ? { agent: p.agent } : {}),
    ...(p.compile ? { compile: p.compile } : {}),
  });
  return { do: (req) => verb.do(req), abilities };
}
