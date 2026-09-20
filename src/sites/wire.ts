/**
 * The site facade from the worker's parts: one instance per process, shared
 * by the HTTP face, the CLI and the `sites` Restate service, so a token a
 * setup step just kept is visible to the next call whichever door it came in.
 */
import type { FlowRunner } from "../browser/flow.js";
import { httpClient } from "../clients/http.js";
import type { SecretSink } from "../deps/sink.js";
import { BROWSER_FLOWS } from "../engine/browser-service.js";
import type { CompiledCatalog } from "../workflows/compiled.js";
import { runCompiled } from "../workflows/proof.js";
import { type SiteFacade, siteFacade } from "./facade.js";
import { SITES } from "./index.js";

export interface SiteParts {
  catalog: CompiledCatalog;
  browser: FlowRunner;
  sink: SecretSink;
  oauthPort: number;
}

export function sitesFor(p: SiteParts): SiteFacade {
  // What setup keeps is visible to the next call at once, whichever sink is behind it.
  const made = new Map<string, string>();
  return siteFacade(SITES, {
    http: httpClient(),
    env: (name) => made.get(name) ?? process.env[name],
    sink: {
      put: async (name, value) => {
        await p.sink.put(name, value);
        made.set(name, value);
      },
    },
    runner: p.browser,
    flow: (name) => BROWSER_FLOWS[name] ?? null,
    compiled: {
      get: async (name) => (await p.catalog.get(name))?.workflow ?? null,
      run: (workflow, plan) =>
        runCompiled(workflow, p.browser, { plan, sink: p.sink, approve: true }),
    },
    oauthPort: p.oauthPort,
  });
}
