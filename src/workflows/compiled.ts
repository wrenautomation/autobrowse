/**
 * Compiled workflows register themselves: every `src/workflows/<name>/
 * index.ts` that exports a `workflow` is served next to the hand-written
 * ones. Their deps are the browser runner only (a recording is a browser
 * chore; anything with an API belongs in wren). Compile from the UI or
 * the CLI, restart the worker, run it from the Runs page.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlowRunner } from "../browser/flow.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { type Proof, readProof } from "./proof.js";

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
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || HAND_WRITTEN.has(entry.name)) continue;
    const dir = join(root, entry.name);
    const file = ["index.ts", "index.js"].map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!file) continue;
    try {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const workflow = mod.workflow ?? Object.values(mod).find(isWorkflow);
      if (isWorkflow(workflow)) out.push({ workflow, dir, proof: readProof(dir) });
    } catch (err) {
      onError(dir, err);
    }
  }
  return out;
}

/** What a compiled workflow needs: the runner, nothing else. */
export function compiledDeps(browser: FlowRunner): { browser: FlowRunner } {
  return { browser };
}
