/**
 * Create an Anthropic Console API key with a specified name and no expiration date.
 * Compiled from the recording "anthropic-console-api-key". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  rejected,
  type SecretSink,
  type StepDef,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  name: z.string().min(1).describe("Name"), // e.g. "autobrowse-prod"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  sink: SecretSink;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface NavigateToApiKeysInput {
  name: string;
  sink: SecretSink;
}

const navigateToApiKeysFlow = defineFlow<NavigateToApiKeysInput, void>({
  site: "anthropic",
  name: "navigate-to-api-keys",
  async run(fp, input) {
    await fp.open("https://platform.claude.com/settings/workspaces/default/keys");
    // The first "Create key" only opens the dialog; the one after the form mints the key.
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create key" },
      { goal: "click Create key" },
    ); // page.getByRole("button", { name: "Create key", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Continue with an API key" },
      { goal: "click Continue with an API key" },
    ); // page.getByRole("button", { name: "Continue with an API key", exact: true })
    await fp.act(
      { kind: "fill", value: input.name },
      { role: "textbox", name: "Name" },
      { goal: "fill Name" },
    ); // page.getByRole("textbox", { name: "Name", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "combobox", name: "Expires" },
      { goal: "click Expires" },
    ); // page.getByRole("combobox", { name: "Expires", exact: true })
    await fp.act({ kind: "click" }, { role: "option", name: "Never" }, { goal: "click Never" }); // page.getByRole("option", { name: "Never", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create key" },
      { goal: "click Create key", irreversible: true },
    ); // page.getByRole("button", { name: "Create key", exact: true })
    await input.sink.put("ANTHROPIC_API_KEY", await fp.read({ css: "[role=dialog] p", nth: 1 })); // page.locator("[role=dialog] p")
    await fp.act({ kind: "click" }, { role: "button", name: "Done" }, { goal: "click Done" }); // page.getByRole("button", { name: "Done", exact: true })
  },
});

const navigateToApiKeys: Step<"navigate-to-api-keys"> = {
  name: "navigate-to-api-keys",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate(
      "human",
      'Run "navigate-to-api-keys" (Navigate to the API keys settings page.)?',
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    await fx.run("browser navigate-to-api-keys", () =>
      deps.browser.run(navigateToApiKeysFlow, { name: plan.name, sink: deps.sink }),
    );
    // Proof: the key works. `sink` holds it; a Messages call with it is the read-back (owed).
    return done("API key created and kept as ANTHROPIC_API_KEY");
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "anthropic-console-api-key",
  description: "Create an Anthropic Console API key with a specified name and no expiration date.",
  plan: planSchema,
  steps: [navigateToApiKeys],
  emptyMemo: () => ({}),
});
