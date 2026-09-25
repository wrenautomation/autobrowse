/**
 * Create an Anthropic Console API key (no expiry), prove it answers, keep it.
 * From the explore recording "anthropic-console-api-key" (2026-09-20), made
 * by hand since: the key is found by its shape, not a paragraph index, and is
 * kept only after `GET /v1/models` (free) accepts it. The key never leaves
 * the flow: not in the journal, not in a step's result.
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
  name: z.string().min(1).describe("Key name in the Console, e.g. autobrowse-prod"),
  keepAs: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default("ANTHROPIC_API_KEY")
    .describe("Env name the key is kept under"),
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  sink: SecretSink;
  /** For the proof call; the global fetch unless given. */
  fetch?: typeof fetch;
}

export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

const KEY = /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/;
const KEYS_PAGE = "https://platform.claude.com/settings/workspaces/default/keys";

/** The Messages API accepts the key: a models list is free and needs no credits. */
export async function keyWorks(key: string, f: typeof fetch = fetch): Promise<boolean> {
  const res = await f("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  return res.ok;
}

export interface CreateKeyInput {
  name: string;
  keepAs: string;
  sink: SecretSink;
  fetch?: typeof fetch;
}

export const createKeyFlow = defineFlow<CreateKeyInput, void>({
  site: "anthropic",
  name: "create-key",
  async run(fp, input) {
    await fp.open(KEYS_PAGE);
    // The first "Create key" only opens the dialog; the one after the form mints the key.
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create key" },
      { goal: "open the form" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Continue with an API key" },
      { goal: "pick an API key" },
    );
    await fp.act(
      { kind: "fill", value: input.name },
      { role: "textbox", name: "Name" },
      { goal: "name it" },
    );
    await fp.act(
      { kind: "click" },
      { role: "combobox", name: "Expires" },
      { goal: "open Expires" },
    );
    await fp.act({ kind: "click" }, { role: "option", name: "Never" }, { goal: "never expire" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create key" },
      { goal: "mint the key", irreversible: true },
    );
    const key = (await fp.read({ css: "[role=dialog]" })).match(KEY)?.[0];
    if (!key) throw new Error("no sk-ant key on the dialog");
    if (!(await keyWorks(key, input.fetch)))
      throw new Error(`the new key "${input.name}" was refused by GET /v1/models; not kept`);
    await input.sink.put(input.keepAs, key);
    await fp.act({ kind: "click" }, { role: "button", name: "Done" }, { goal: "close the dialog" });
  },
});

const createKey: Step<"create-key"> = {
  name: "create-key",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate(
      "send",
      `Create Anthropic API key "${plan.name}" and keep it as ${plan.keepAs}?`,
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    await fx.run("browser create-key", () =>
      deps.browser.run(createKeyFlow, {
        name: plan.name,
        keepAs: plan.keepAs,
        sink: deps.sink,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    );
    return done(`key "${plan.name}" answers GET /v1/models; kept as ${plan.keepAs}`);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "anthropic-console-api-key",
  description: "Create an Anthropic Console API key (no expiry), prove it answers, keep it.",
  plan: planSchema,
  steps: [createKey],
  emptyMemo: () => ({}),
});
