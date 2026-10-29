/**
 * Every leg run outside a workflow's step goes through here (designs/2026-10-29-one-workflow-system.md,
 * the fold): the leg as a one-step engine run, written to the engine ledger. Light on imports, so
 * auth and `do` reach it with no cycle through the flows.
 */
import type { Page } from "playwright";
import { z } from "zod";
import { currentCall } from "../browser/attempt.js";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { statsDirOf } from "../deps/stats.js";
import { type EngineRuns, fileEngineRuns } from "../runs/engine.js";
import { memoryEffects } from "./memory.js";
import { type RunFlowOptions, runFlow } from "./run.js";
import { done, type Workflow } from "./workflow.js";

/** `google/oauth-consent` → `google-oauth-consent`; a name that starts with its site keeps it once. */
export const legName = (flow: Pick<BrowserFlow<never, unknown>, "site" | "name">): string =>
  flow.name.startsWith(`${flow.site}-`) ? flow.name : `${flow.site}-${flow.name}`;

let ledger: EngineRuns | null | undefined;
/** The engine ledger under the stats dir, null when stats are off. */
export const engineRuns = (): EngineRuns | null => {
  if (ledger === undefined) {
    const dir = statsDirOf("engine");
    ledger = dir ? fileEngineRuns(dir) : null;
  }
  return ledger;
};

/** `runFlow`'s `record` for an in-process run: the engine ledger, under the durable call. */
export const recorded = (): RunFlowOptions => {
  const runs = engineRuns();
  return runs ? { record: { runs, key: currentCall() } } : {};
};

const PLAN = z.object({ dryRun: z.boolean() });

/**
 * The caller gets the leg's own answer and error, as they were: the step sees them only as text.
 * The input and the armed tab (`on`) go to the leg as given; a plan would drop what is not JSON (a
 * key sink).
 */
export async function runLeg<I, O>(
  runner: FlowRunner,
  flow: BrowserFlow<I, O>,
  input: I,
  o: { on?: { page: Page }; runs?: EngineRuns | null } = {},
): Promise<O> {
  let got: { out: O } | { err: unknown } | null = null;
  const workflow: Workflow<{ dryRun: boolean }, null, Record<string, never>> = {
    name: legName(flow as BrowserFlow<never, unknown>),
    description: `${flow.site}/${flow.name}`,
    site: flow.site,
    plan: PLAN,
    emptyMemo: () => ({}),
    steps: [
      {
        name: flow.name,
        irreversible: true,
        async run() {
          try {
            got = { out: await runner.run(flow, input, o.on) };
          } catch (err) {
            got = { err };
            throw err;
          }
          return done("done");
        },
      },
    ],
  };
  const runs = o.runs === undefined ? engineRuns() : o.runs;
  await runFlow(
    memoryEffects().fx,
    workflow,
    null,
    { dryRun: false },
    () => null,
    runs ? { record: { runs, key: currentCall() } } : {},
  );
  const r = got as { out: O } | { err: unknown } | null;
  if (!r) throw new Error(`leg ${flow.site}/${flow.name} did not run`);
  if ("err" in r) throw r.err;
  return r.out;
}
