/**
 * A compiled workflow's proof: it ran once, deterministically, after being
 * compiled, and here is how it went. Written as `proof.json` beside the
 * workflow, read at boot, shown on the Runs page. A flow without a proof
 * is a draft; one whose proof failed says which step to repair.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowRunner } from "../browser/flow.js";
import { memoryEffects } from "../engine/memory.js";
import { type Outcome, runFlow } from "../engine/run.js";
import type { AnyWorkflow } from "../engine/workflow.js";

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
export async function proveWorkflow(
  workflow: AnyWorkflow,
  browser: FlowRunner,
  opts: { plan?: Record<string, unknown>; now?: () => Date } = {},
): Promise<Proof> {
  const plan = workflow.plan.parse({ ...(opts.plan ?? {}), dryRun: false });
  const out = await runFlow(memoryEffects().fx, workflow as never, { browser } as never, plan);
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
  return {
    at: (opts.now ?? (() => new Date()))().toISOString(),
    status: out.status,
    steps,
    output,
  };
}

export function writeProof(dir: string, proof: Proof): string {
  const file = join(dir, PROOF_FILE);
  writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`);
  return file;
}

export function readProof(dir: string): Proof | null {
  try {
    return JSON.parse(readFileSync(join(dir, PROOF_FILE), "utf8")) as Proof;
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
