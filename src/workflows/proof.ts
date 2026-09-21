/**
 * A compiled workflow's proof: it ran once, deterministically, after being
 * compiled, and here is how it went. Written as `proof.json` beside the
 * workflow, read at boot, shown on the Runs page. A flow without a proof
 * is a draft; one whose proof failed says which step to repair.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FlowRunner } from "../browser/flow.js";
import type { SecretSink } from "../deps/sink.js";
import { memoryEffects } from "../engine/memory.js";
import { type Outcome, runFlow } from "../engine/run.js";
import type { AnyWorkflow } from "../engine/workflow.js";
import { compiledDeps } from "./compiled-deps.js";

export const PROOF_FILE = "proof.json";

export interface Proof {
  at: string;
  status: Outcome["status"];
  /** Step → status and one line, in the order they ran. */
  steps: Array<{ name: string; status: string; detail: string }>;
  /** What was read, when the flow reads anything. */
  output: Record<string, string> | null;
}

/** Run the workflow once in this process on its own plan defaults; gates are declined (a proof never buys). */
/**
 * One in-process run of a compiled workflow: in-memory journal, the
 * worker's browser, the output the last step read (a JSON detail). Gates
 * answer as told: declined for a proof, approved for a call an orchestrator
 * has already gated.
 */
/** Run the workflow's flows at `site` under `profile` instead (a second account at the provider). */
export interface RunAs {
  site: string;
  profile: string;
}

/** The runner with every flow at `as.site` re-sited to `as.profile`; other sites run as themselves. */
export function runnerAs(browser: FlowRunner, as: RunAs | undefined): FlowRunner {
  if (!as || as.site === as.profile) return browser;
  return {
    run: (flow, input) =>
      browser.run(flow.site === as.site ? { ...flow, site: as.profile } : flow, input),
  };
}

export async function runCompiled(
  workflow: AnyWorkflow,
  browser: FlowRunner,
  o: { plan?: Record<string, unknown>; sink?: SecretSink; approve?: boolean; as?: RunAs } = {},
): Promise<Pick<Proof, "status" | "steps" | "output">> {
  const plan = workflow.plan.parse({ ...(o.plan ?? {}), dryRun: false });
  const out = await runFlow(
    memoryEffects().fx,
    workflow as never,
    compiledDeps(runnerAs(browser, o.as), o.sink ? { sink: o.sink } : {}) as never,
    plan,
    () =>
      o.approve
        ? { approved: true, note: "gated by the caller", at: new Date().toISOString() }
        : null,
  );
  const steps = Object.entries(out.results).flatMap(([name, r]) =>
    r ? [{ name, status: r.status, detail: r.detail }] : [],
  );
  const last = steps.at(-1)?.detail ?? "";
  let output: Proof["output"] = null;
  if (out.status === "done" && last.startsWith("{")) {
    try {
      output = JSON.parse(last) as Record<string, string>;
    } catch {
      output = null;
    }
  }
  return { status: out.status, steps, output };
}

export async function proveWorkflow(
  workflow: AnyWorkflow,
  browser: FlowRunner,
  opts: { plan?: Record<string, unknown>; now?: () => Date } = {},
): Promise<Proof> {
  const run = await runCompiled(workflow, browser, opts.plan ? { plan: opts.plan } : {});
  return { at: (opts.now ?? (() => new Date()))().toISOString(), ...run };
}

export async function writeProof(dir: string, proof: Proof): Promise<string> {
  const file = join(dir, PROOF_FILE);
  await writeFile(file, `${JSON.stringify(proof, null, 2)}\n`);
  return file;
}

export async function readProof(dir: string): Promise<Proof | null> {
  try {
    return JSON.parse(await readFile(join(dir, PROOF_FILE), "utf8")) as Proof;
  } catch {
    return null;
  }
}

/** One line for a message or a log. */
export function proofLine(proof: Proof): string {
  if (proof.status === "done") {
    const out = proof.output ? ` → ${JSON.stringify(proof.output)}` : "";
    return `proven ${proof.at.slice(0, 16)}${out}`;
  }
  const failed = proof.steps.find((s) => s.status !== "done" && s.status !== "skipped");
  return `proof ${proof.status}${failed ? ` at ${failed.name}: ${failed.detail}` : ""}`;
}
