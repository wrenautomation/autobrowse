/**
 * Ask AWS to remove the EC2 email sending limit (port 25) for one Elastic IP
 * and set its reverse DNS: the "Request to remove email sending limitations"
 * form at support/contacts#/rdns-limits. Compiled from the recording
 * "aws-port25-request", then given its gate: the submit files a request in
 * the account owner's name, so a person approves it first.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  rejected,
  type StepDef,
  skipped,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  /** The address AWS answers to; the form does not prefill it. */
  contactEmail: z.string().email().describe("Email address"),
  useCaseDescription: z.string().min(1).describe("Use case description"),
  elasticIpAddress: z.string().min(1).describe("Elastic IP address"), // e.g. "34.233.233.146"
  reverseDnsRecord: z.string().min(1).describe("Reverse DNS record"), // e.g. "probe.wrenautomation.com"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
}

export interface Memo {
  /** What the page said after Submit. */
  confirmation?: string;
}

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

const FORM_URL = "https://support.console.aws.amazon.com/support/contacts#/rdns-limits";

export interface FormInput {
  contactEmail: string;
  useCaseDescription: string;
  elasticIpAddress: string;
  reverseDnsRecord: string;
  /** Click Submit and read the confirmation; false leaves the filled form for a look. */
  submit: boolean;
}

/** Fill the form; with `submit`, send it and return what the page said. */
export const port25RequestFlow = defineFlow<FormInput, { confirmation: string | null }>({
  site: "aws",
  name: "port25-request",
  async run(fp, input) {
    await fp.open(FORM_URL);
    const fields: ReadonlyArray<[string, string]> = [
      ["Email address", input.contactEmail],
      ["Use case description", input.useCaseDescription],
      ["Elastic IP address - optional", input.elasticIpAddress],
      ["Reverse DNS record - optional", input.reverseDnsRecord],
    ];
    for (const [name, value] of fields) {
      await fp.act({ kind: "fill", value }, { role: "textbox", name }, { goal: `fill ${name}` });
    }
    if (!input.submit) return { confirmation: null };
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Submit" },
      { goal: "submit the request" },
    );
    await fp.wait(3_000);
    const text = await fp.text();
    if (/error|required|invalid/i.test(text) && (await fp.has({ role: "button", name: "Submit" })))
      fp.human("AWS did not accept the form; see the screenshot");
    const said = text.match(/(thank you|submitted|received|we will|case id[^\n]*)[^\n]*/i);
    return { confirmation: said ? said[0].trim() : text.slice(0, 300) };
  },
});

const fill: Step<"fill"> = {
  name: "fill",
  async run({ fx, deps, plan }) {
    await fx.run("browser fill port25 form", () =>
      deps.browser.run(port25RequestFlow, { ...plan, submit: false }),
    );
    return done(`form filled for ${plan.elasticIpAddress} → ${plan.reverseDnsRecord}, not sent`);
  },
};

const submit: Step<"submit"> = {
  name: "submit",
  irreversible: true,
  async run({ fx, deps, plan, memo, gate }) {
    if (memo.confirmation) return skipped("already submitted");
    const answer = gate(
      "send",
      `Send AWS the request to remove the email sending limit on ${plan.elasticIpAddress} (rDNS ${plan.reverseDnsRecord}), replies to ${plan.contactEmail}? It opens a request in the account owner's name.`,
    );
    if (!answer.approved) return rejected(answer.note ?? "not sent");
    const { confirmation } = await fx.run("browser submit port25 form", () =>
      deps.browser.run(port25RequestFlow, { ...plan, submit: true }),
    );
    memo.confirmation = confirmation ?? "submitted";
    return done(`sent; AWS said: ${memo.confirmation}`);
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "aws-port25-request",
  description:
    "Ask AWS to remove the EC2 email sending limit for an Elastic IP and set its reverse DNS",
  plan: planSchema,
  steps: [fill, submit],
  emptyMemo: () => ({}),
});
