/**
 * The hand-written browser legs as workflows (designs/2026-10-29-one-workflow-system.md): one step
 * that runs the leg, its plan the leg's input (inputs.gen.ts) plus `dryRun`. Named `<site>-<name>`,
 * kebab like every workflow; the leg's own `site/name` stays its trace and catalog key.
 */
import { z } from "zod";
import type { BrowserFlow, FlowRunner } from "../browser/flow.js";
import { FLOW_INPUTS } from "../browser/flows/inputs.gen.js";
import { done, type Workflow } from "../engine/workflow.js";
import type { CompiledCatalog } from "./compiled.js";

export interface LegDeps {
  browser: FlowRunner;
}

/** `google/oauth-consent` → `google-oauth-consent`; a name that starts with its site keeps it once. */
export const legName = (flow: Pick<BrowserFlow<never, unknown>, "site" | "name">): string =>
  flow.name.startsWith(`${flow.site}-`) ? flow.name : `${flow.site}-${flow.name}`;

const DRY = z.object({ dryRun: z.boolean().default(false) });

/** One leg as a one-step workflow. An object input's fields are the plan's own; any other input sits under `input`. */
export function legWorkflow<I, O>(
  flow: BrowserFlow<I, O>,
  input: z.ZodType<I>,
): Workflow<{ dryRun: boolean }, LegDeps, Record<string, never>> {
  const flat = input instanceof z.ZodObject;
  const plan = flat
    ? (input as unknown as z.ZodObject).extend(DRY.shape)
    : input instanceof z.ZodUndefined
      ? DRY
      : DRY.extend({ input });
  const name = legName(flow as BrowserFlow<never, unknown>);
  return {
    name,
    description: `${flow.site}/${flow.name}`,
    plan: plan as unknown as z.ZodType<{ dryRun: boolean }>,
    emptyMemo: () => ({}),
    steps: [
      {
        name: flow.name,
        // What a leg does is its own: a dry run stops before it.
        irreversible: true,
        async run({ deps, plan: p }) {
          const { dryRun: _, ...rest } = p as { dryRun: boolean } & Record<string, unknown>;
          const given = (flat ? rest : (rest as { input?: unknown }).input) as I;
          const out = await deps.browser.run(flow, given);
          // A secret leg's answer can hold what it minted: the step keeps only that it ran.
          return done(flow.secret ? "done" : JSON.stringify(out ?? null));
        },
      },
    ],
  };
}

/** Every hand-written leg as a workflow, by name. */
export const LEG_WORKFLOWS: ReadonlyMap<
  string,
  Workflow<{ dryRun: boolean }, LegDeps, Record<string, never>>
> = new Map(
  FLOW_INPUTS.map((e) => {
    const w = legWorkflow(e.flow, e.input as z.ZodType<never>);
    return [w.name, w] as const;
  }),
);

/** One catalog: compiled workflows first (a recording may take a leg's name on purpose), then the legs. */
export function workflowCatalog(compiled: CompiledCatalog) {
  return {
    async get(name: string) {
      return (await compiled.get(name))?.workflow ?? LEG_WORKFLOWS.get(name) ?? null;
    },
  };
}
