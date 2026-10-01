/** Restate ingress clients for the CLI and the UI server: one place that knows the object names. */
import * as clients from "@restatedev/restate-sdk-clients";
import { BROWSER_SERVICE, type BrowserService } from "../engine/browser-service.js";
import type { RunObject } from "../engine/object.js";
import { REGISTRY_KEY, type RunsRegistry, registryOf } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { DEFAULT_OWNER, named } from "../owner.js";
import { SITES_SERVICE, type SitesService } from "../sites/service.js";
import { COMPILED_OBJECT, compiledKey, HAND_WRITTEN } from "../workflows/compiled.js";

export interface IngressOptions {
  url: string;
  authToken?: string | null;
  /** Whose worker to call: every object and service name carries it. */
  owner?: string;
}

export function ingress(opts: IngressOptions) {
  const conn = clients.connect({
    url: opts.url,
    ...(opts.authToken ? { headers: { authorization: `Bearer ${opts.authToken}` } } : {}),
  });
  const owner = opts.owner ?? DEFAULT_OWNER;
  const compiled = { name: named(COMPILED_OBJECT.name, owner) };
  return {
    /** A run of `workflow`: hand-written ones have an object each; compiled ones share `Compiled`. */
    run: (workflow: string, key: string) =>
      HAND_WRITTEN.has(workflow)
        ? conn.objectClient<RunObject<AnyWorkflow>>({ name: named(workflow, owner) }, key)
        : conn.objectClient<RunObject<AnyWorkflow>>(compiled, compiledKey(workflow, key)),
    registry: () =>
      conn.objectClient<RunsRegistry>(registryOf(owner) as RunsRegistry, REGISTRY_KEY),
    /** The worker's browser legs (`browser/flow`): a flow run on the box, not here. */
    browser: () =>
      conn.serviceClient<BrowserService>({
        name: named(BROWSER_SERVICE, owner),
      } as BrowserService),
    /** The worker's site facade (`sites/*`): the box's tokens, caps and ledger. */
    sites: () =>
      conn.serviceClient<SitesService>({ name: named(SITES_SERVICE, owner) } as SitesService),
  };
}

export type Ingress = ReturnType<typeof ingress>;
