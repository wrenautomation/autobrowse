/**
 * Open the Personal info page on Google and report the display name..
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

export type OpenPersonalInfoInput = Record<string, never>;

const openPersonalInfoFlow = defineFlow<OpenPersonalInfoInput, void>({
  site: "google",
  name: "open-personal-info",
  async run(fp) {
    await fp.open("https://myaccount.google.com/");
    await fp.act(
      { kind: "click" },
      { role: "menuitem", name: "Personal info" },
      { goal: "click Personal info" },
    ); // page.getByRole("menuitem", { name: "Personal info", exact: true })
  },
});

const openPersonalInfo: Step<"open-personal-info"> = {
  name: "open-personal-info",
  async run({ fx, deps }) {
    await fx.run("browser open-personal-info", () => deps.browser.run(openPersonalInfoFlow, {}));
    // TODO: prove the result through an API read where one exists.
    return done("Navigate to the Personal info page by clicking the 'Personal info' menuitem.");
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "google-name",
  description: "Open the Personal info page on Google and report the display name.",
  plan: planSchema,
  steps: [openPersonalInfo],
  emptyMemo: () => ({}),
});
