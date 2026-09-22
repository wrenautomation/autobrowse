/**
 * Sign up for a new Instagram account with name, username, email, password, birthday, and email confirmation code..
 * Compiled from the recording "signup-instagram". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 *
 * Secrets (set as env, see SecretSource): email, password, code.
 */

import { z } from "zod";
import {
  defineFlow,
  defineWorkflow,
  done,
  type FlowRunner,
  rejected,
  type SecretSource,
  type StepDef,
} from "../../index.js";

export const planSchema = z.object({
  dryRun: z.boolean().default(false),
  fullName: z.string().min(1).describe("Name Full name"), // e.g. "Wren Automation"
  username: z.string().min(1).describe("Username"), // e.g. "wrenautomation"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  secrets: SecretSource;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export interface SubmitSignupFormInput {
  fullName: string;
  username: string;
  email: string;
  password: string;
  code: string;
}

const submitSignupFormFlow = defineFlow<SubmitSignupFormInput, void>({
  site: "instagram",
  name: "submit-signup-form",
  async run(fp, input) {
    await fp.open("https://www.instagram.com/accounts/emailsignup/");
    await fp.act(
      { kind: "select", value: "June" },
      { role: "combobox", name: "Select Month" },
      { goal: "select June in Select Month" },
    ); // page.getByRole("combobox", { name: "Select Month", exact: true })
    await fp.act(
      { kind: "select", value: "15" },
      { role: "combobox", name: "Select Day" },
      { goal: "select 15 in Select Day" },
    ); // page.getByRole("combobox", { name: "Select Day", exact: true })
    await fp.act(
      { kind: "select", value: "1998" },
      { role: "combobox", name: "Select Year" },
      { goal: "select 1998 in Select Year" },
    ); // page.getByRole("combobox", { name: "Select Year", exact: true })
    await fp.act(
      { kind: "fill", value: input.fullName },
      { role: "textbox", name: "Name Full name" },
      { goal: "fill Name Full name" },
    ); // page.getByRole("textbox", { name: "Name Full name", exact: true })
    await fp.act(
      { kind: "fill", value: input.username },
      { role: "combobox", name: "Username" },
      { goal: "fill Username" },
    ); // page.getByRole("combobox", { name: "Username", exact: true })
    await fp.act(
      { kind: "fill", value: input.email },
      { role: "textbox", name: "Mobile number or email Mobile number or email" },
      { goal: "fill Mobile number or email Mobile number or email" },
    ); // page.getByRole("textbox", { name: "Mobile number or email Mobile number or email", exact: true })
    await fp.act(
      { kind: "fill", value: input.password },
      { role: "textbox", name: "Password Password Show password" },
      { goal: "fill Password Password Show password" },
    ); // page.getByRole("textbox", { name: "Password Password Show password", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Submit" },
      { goal: "click Submit", irreversible: true },
    ); // page.getByRole("button", { name: "Submit", exact: true })
    await fp.act({ kind: "click" }, { role: "button", name: "I agree" }, { goal: "click I agree" }); // page.getByRole("button", { name: "I agree", exact: true })
    await fp.act(
      { kind: "fill", value: input.code },
      { role: "textbox", name: "Confirmation code" },
      { goal: "fill Confirmation code" },
    ); // page.getByRole("textbox", { name: "Confirmation code", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Continue" },
      { goal: "click Continue" },
    ); // page.getByRole("button", { name: "Continue", exact: true })
  },
});

const submitSignupForm: Step<"submit-signup-form"> = {
  name: "submit-signup-form",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate(
      "send",
      'Run "submit-signup-form" (Fill birthday, name, username, email, and password, then submit the signup form, accept terms, and enter the email confirmation code to create the account.)?',
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    // Outside fx.run on purpose: the journal must never hold it.
    const email = await deps.secrets.get("email");
    // Outside fx.run on purpose: the journal must never hold it.
    const password = await deps.secrets.get("password");
    // Outside fx.run on purpose: the journal must never hold it.
    const code = await deps.secrets.get("code");
    await fx.run("browser submit-signup-form", () =>
      deps.browser.run(submitSignupFormFlow, {
        fullName: plan.fullName,
        username: plan.username,
        email,
        password,
        code,
      }),
    );
    // TODO: prove the result through an API read where one exists.
    return done(
      "Fill birthday, name, username, email, and password, then submit the signup form, accept terms, and enter the email confirmation code to create the account.",
    );
  },
};

export type DismissNotificationsPromptInput = Record<string, never>;

const dismissNotificationsPromptFlow = defineFlow<DismissNotificationsPromptInput, void>({
  site: "instagram",
  name: "dismiss-notifications-prompt",
  async run(fp) {
    await fp.open("https://www.instagram.com/accounts/emailsignup/");
    await fp.act({ kind: "click" }, { role: "button", name: "Not Now" }, { goal: "click Not Now" }); // page.getByRole("button", { name: "Not Now", exact: true })
  },
});

const dismissNotificationsPrompt: Step<"dismiss-notifications-prompt"> = {
  name: "dismiss-notifications-prompt",
  async run({ fx, deps }) {
    await fx.run("browser dismiss-notifications-prompt", () =>
      deps.browser.run(dismissNotificationsPromptFlow, {}),
    );
    // TODO: prove the result through an API read where one exists.
    return done("Dismiss the post-signup notifications dialog by clicking Not Now.");
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "signup-instagram",
  description:
    "Sign up for a new Instagram account with name, username, email, password, birthday, and email confirmation code.",
  plan: planSchema,
  steps: [submitSignupForm, dismissNotificationsPrompt],
  emptyMemo: () => ({}),
});
