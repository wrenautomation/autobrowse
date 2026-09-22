/**
 * Recorded 2026-09-22 on langfuse.
 * Compiled from the recording "langfuse-project-keys". Edit freely: the outline was the
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
  noteOptional: z.string().min(1).describe("Note (optional)"), // e.g. "autobrowse tracing"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  sink: SecretSink;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface CreateNewApiKeysInput {
  noteOptional: string;
  sink: SecretSink;
}

const createNewApiKeysFlow = defineFlow<CreateNewApiKeysInput, void>({
  site: "langfuse",
  name: "create-new-api-keys",
  async run(fp, input) {
    await fp.open("https://cloud.langfuse.com/project/cmucofs5801xvad0d4o21fb4p/settings/api-keys");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create new API keys" },
      { goal: "click Create new API keys", irreversible: true },
    ); // page.getByRole("button", { name: "Create new API keys", exact: true })
    await fp.act(
      { kind: "fill", value: input.noteOptional },
      { role: "textbox", name: "Note (optional)" },
      { goal: "fill Note (optional)" },
    ); // page.getByRole("textbox", { name: "Note (optional)", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create API keys" },
      { goal: "click Create API keys", irreversible: true },
    ); // page.getByRole("button", { name: "Create API keys", exact: true })
    await input.sink.put("LANGFUSE_SECRET_KEY", await fp.read({ css: "[role=dialog] code" })); // page.locator("[role=dialog] code")
    await input.sink.put(
      "LANGFUSE_PUBLIC_KEY",
      await fp.read({ css: "[role=dialog] code", nth: 1 }),
    ); // page.locator("[role=dialog] code")
    await fp.act({ kind: "click" }, { role: "button", name: "Close" }, { goal: "click Close" }); // page.getByRole("button", { name: "Close", exact: true })
  },
});

const createNewApiKeys: Step<"create-new-api-keys"> = {
  name: "create-new-api-keys",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate(
      "send",
      'Run "create-new-api-keys" (Click the button to start creating new API keys for the Langfuse project.)?',
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    await fx.run("browser create-new-api-keys", () =>
      deps.browser.run(createNewApiKeysFlow, { noteOptional: plan.noteOptional, sink: deps.sink }),
    );
    // TODO proof: GET /projects/{projectId}/api-keys returns a list containing the newly created keys.
    return done("Click the button to start creating new API keys for the Langfuse project.");
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "langfuse-project-keys",
  description: "Recorded 2026-09-22 on langfuse",
  plan: planSchema,
  steps: [createNewApiKeys],
  emptyMemo: () => ({}),
});
