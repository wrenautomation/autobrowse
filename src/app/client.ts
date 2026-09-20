/** Restate ingress clients for the CLI and the UI server: one place that knows the object names. */
import * as clients from "@restatedev/restate-sdk-clients";
import type { RunObject } from "../engine/object.js";
import { REGISTRY, REGISTRY_KEY, type RunsRegistry } from "../engine/registry.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { COMPILED_OBJECT, compiledKey, HAND_WRITTEN } from "../workflows/compiled.js";

export interface IngressOptions {
  url: string;
  authToken?: string | null;
}

export function ingress(opts: IngressOptions) {
  const conn = clients.connect({
    url: opts.url,
    ...(opts.authToken ? { headers: { authorization: `Bearer ${opts.authToken}` } } : {}),
  });
  return {
    /** A run of `workflow`: hand-written ones have an object each; compiled ones share `Compiled`. */
    run: (workflow: string, key: string) =>
      HAND_WRITTEN.has(workflow)
        ? conn.objectClient<RunObject<AnyWorkflow>>({ name: workflow }, key)
        : conn.objectClient<RunObject<AnyWorkflow>>(COMPILED_OBJECT, compiledKey(workflow, key)),
    registry: () => conn.objectClient<RunsRegistry>(REGISTRY, REGISTRY_KEY),
  };
}

export type Ingress = ReturnType<typeof ingress>;
