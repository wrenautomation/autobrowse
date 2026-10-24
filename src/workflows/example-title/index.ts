/**
 * Recorded 2026-09-20 on example.
 * Compiled from the recording "example-title". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 */

import { z } from "zod";
import { defineFlow, defineWorkflow, done, type FlowRunner, type StepDef } from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export type ReadMainHeadingInput = Record<string, never>;

const readMainHeadingFlow = defineFlow<ReadMainHeadingInput, Record<string, string>>({
  site: "example",
  name: "read-main-heading",
  async run(fp) {
    await fp.open("https://example.com/");
    const out: Record<string, string> = {};
    // 2026-10: example.com dropped its <h1>; the page is one paragraph now.
    out.text = await fp.read({ role: "paragraph" });
    return out;
  },
});

const readMainHeading: Step<"read-main-heading"> = {
  name: "read-main-heading",
  async run({ fx, deps }) {
    const out = await fx.run("browser read-main-heading", () =>
      deps.browser.run(readMainHeadingFlow, {}),
    );
    // TODO: prove the result through an API read where one exists.
    return done(JSON.stringify(out));
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "example-title",
  description: "Recorded 2026-09-20 on example",
  plan: planSchema,
  steps: [readMainHeading],
  emptyMemo: () => ({}),
});
