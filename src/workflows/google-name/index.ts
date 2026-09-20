/**
 * Recorded 2026-09-20 on google.
 * Compiled from the recording "google-name". Edit freely: the outline was the
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

export type TheGoalIsToOpenThePersonalInfoInput = Record<string, never>;

const theGoalIsToOpenThePersonalInfoFlow = defineFlow<TheGoalIsToOpenThePersonalInfoInput, void>({
  site: "google",
  name: "the-goal-is-to-open-the-personal-info",
  async run(fp, input) {
    await fp.open("https://myaccount.google.com/");
    await fp.act(
      { kind: "click" },
      { role: "menuitem", name: "Personal info" },
      { goal: "click Personal info" },
    ); // page.getByRole("menuitem", { name: "Personal info", exact: true })
  },
});

const theGoalIsToOpenThePersonalInfo: Step<"the-goal-is-to-open-the-personal-info"> = {
  name: "the-goal-is-to-open-the-personal-info",
  async run({ fx, deps, plan }) {
    await fx.run("browser the-goal-is-to-open-the-personal-info", () =>
      deps.browser.run(theGoalIsToOpenThePersonalInfoFlow, {}),
    );
    // TODO: prove the result through an API read where one exists.
    return done(
      "The goal is to open the Personal info page and report the display name. The Personal info page can be accessed through the menuitem 'Personal info' or the link 'Go to Personal info'. I will click on the menuitem 'Personal info' to navigate to the page.",
    );
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "google-name",
  description: "Recorded 2026-09-20 on google",
  plan: planSchema,
  steps: [theGoalIsToOpenThePersonalInfo],
  emptyMemo: () => ({}),
});
