/**
 * Compiled workflows register themselves: every `src/workflows/<name>/
 * index.ts` that exports a `workflow` is served by one Restate object,
 * `Compiled`, keyed `<workflow>/<key>`, which loads the flow from disk
 * when a run needs it. Compile from the UI or the CLI and run it from the
 * Runs page: no restart. A rewritten flow is reloaded by its mtime. Their
 * deps are the browser runner only (a recording is a browser chore;
 * anything with an API belongs in wren).
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as restate from "@restatedev/restate-sdk";
import type { SecretAudit } from "credvault";
import type { FlowRunner } from "../browser/flow.js";
import type { SecretSink } from "../deps/sink.js";
import { type HostDeps, makeRunObjectFrom, type RunObjectDefinition } from "../engine/object.js";
import type { AdvanceOptions } from "../engine/run.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { named } from "../owner.js";
import { type CompiledDeps, compiledDeps } from "./compiled-deps.js";
import { type Proof, readProof } from "./proof.js";

export { type CompiledDeps, compiledDeps };

/** Hand-written workflows, wired with their own deps in services.ts. */
export const HAND_WRITTEN = new Set(["domain", "bootstrap"]);

export interface CompiledWorkflow {
  workflow: AnyWorkflow;
  dir: string;
  /** The last proof run, or null for a draft nobody has run yet. */
  proof: Proof | null;
}

function isWorkflow(v: unknown): v is AnyWorkflow {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { name?: unknown }).name === "string" &&
    Array.isArray((v as { steps?: unknown }).steps)
  );
}

/** Every compiled workflow under `root`; a module that fails to load is reported, not fatal. */
export async function loadCompiledWorkflows(
  root: string,
  onError: (dir: string, err: unknown) => void = () => undefined,
): Promise<CompiledWorkflow[]> {
  if (!existsSync(root)) return [];
  const out: CompiledWorkflow[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || HAND_WRITTEN.has(entry.name)) continue;
    const dir = join(root, entry.name);
    const file = ["index.ts", "index.js"].map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!file) continue;
    try {
      // The mtime in the URL makes a rewritten flow a new module; the old one stays cached, harmless.
      const url = `${pathToFileURL(file).href}?v=${(await stat(file)).mtimeMs}`;
      const mod = (await import(url)) as Record<string, unknown>;
      const workflow = mod.workflow ?? Object.values(mod).find(isWorkflow);
      if (isWorkflow(workflow)) out.push({ workflow, dir, proof: await readProof(dir) });
    } catch (err) {
      onError(dir, err);
    }
  }
  return out;
}

/** The object every compiled workflow runs under; its key is `<workflow>/<run key>`. */
export const COMPILED_OBJECT = { name: "Compiled" } as const;

export const compiledKey = (workflow: string, key: string): string => `${workflow}/${key}`;

/** `<workflow>/<key>` → its parts; a key may itself hold slashes. */
export function splitCompiledKey(objectKey: string): { workflow: string; key: string } {
  const i = objectKey.indexOf("/");
  if (i <= 0 || i === objectKey.length - 1)
    throw new Error(`a Compiled key is <workflow>/<key>, got "${objectKey}"`);
  return { workflow: objectKey.slice(0, i), key: objectKey.slice(i + 1) };
}

export interface CompiledCatalog {
  /** Every compiled workflow on disk right now. */
  list(): Promise<CompiledWorkflow[]>;
  get(name: string): Promise<CompiledWorkflow | null>;
  /** Last proof runs by name. */
  proofs(): Promise<Record<string, Proof | null>>;
}

/** Reads the directory on every call: a compile shows up at once, and a directory listing is cheap. */
export function compiledCatalog(
  root: string,
  onError: (dir: string, err: unknown) => void = () => undefined,
): CompiledCatalog {
  const list = () => loadCompiledWorkflows(root, onError);
  return {
    list,
    get: async (name) => (await list()).find((c) => c.workflow.name === name) ?? null,
    proofs: async () => Object.fromEntries((await list()).map((c) => [c.workflow.name, c.proof])),
  };
}

/** The one run object for every compiled workflow; a run of `w` under key `k` is `Compiled/w/k`. */
export function makeCompiledRunObject(o: {
  catalog: CompiledCatalog;
  browser: FlowRunner;
  host: HostDeps;
  opts?: AdvanceOptions;
  /** The worker's secret sink (.env or SSM) for `keep` ops. */
  sink?: SecretSink;
  /** Where every secret fill is recorded (see auth/guard). */
  audit?: SecretAudit;
}): RunObjectDefinition<AnyWorkflow> {
  return makeRunObjectFrom(
    named(COMPILED_OBJECT.name, o.host.owner),
    async (objectKey) => {
      const ref = splitCompiledKey(objectKey);
      const found = await o.catalog.get(ref.workflow);
      if (!found)
        throw new restate.TerminalError(`no compiled workflow named ${ref.workflow}`, {
          errorCode: 404,
        });
      return {
        workflow: found.workflow,
        deps: compiledDeps(o.browser, {
          ...(o.sink ? { sink: o.sink } : {}),
          ...(o.audit ? { audit: o.audit } : {}),
        }),
        ref,
      };
    },
    o.host,
    o.opts ?? {},
    splitCompiledKey,
  );
}
