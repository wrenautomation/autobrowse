/**
 * A Google Cloud project to hold OAuth clients and API enablements; its id is kept as GOOGLE_CLOUD_PROJECT.
 * Compiled from the recording "google-cloud-project". Edit freely: the outline was the
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
  name: z.string().min(1).describe("Project name"), // e.g. "wren"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  sink: SecretSink;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface CreateProjectInput {
  name: string;
  sink: SecretSink;
}

const createProjectFlow = defineFlow<CreateProjectInput, void>({
  site: "google",
  name: "create-project",
  async run(fp, input) {
    await fp.open("https://console.cloud.google.com/projectcreate");
    await fp.act(
      { kind: "fill", value: input.name },
      { role: "textbox", name: "Project name" },
      { goal: "fill Project name" },
    ); // page.getByRole("textbox", { name: "Project name", exact: true })
    await fp.act(
      { kind: "click" },
      { tag: "button", role: "button", name: "Edit the project id." },
      { goal: "click Edit the project id." },
    ); // page.getByRole("button", { name: "Edit the project id.", exact: true })
    await input.sink.put(
      "GOOGLE_CLOUD_PROJECT",
      await fp.read({ tag: "input", role: "textbox", name: "Project ID" }),
    ); // page.getByRole("textbox", { name: "Project ID", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create" },
      { goal: "click Create", irreversible: true },
    ); // page.getByRole("button", { name: "Create", exact: true })
  },
});

const createProject: Step<"create-project"> = {
  name: "create-project",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate(
      "human",
      'Run "create-project" (Create the project and keep its id (the console adds a suffix when the name is taken))?',
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    await fx.run("browser create-project", () =>
      deps.browser.run(createProjectFlow, { name: plan.name, sink: deps.sink }),
    );
    // TODO proof: the project id is in the env store
    return done(
      "Create the project and keep its id (the console adds a suffix when the name is taken)",
    );
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "google-cloud-project",
  description:
    "A Google Cloud project to hold OAuth clients and API enablements; its id is kept as GOOGLE_CLOUD_PROJECT",
  plan: planSchema,
  steps: [createProject],
  emptyMemo: () => ({}),
});
