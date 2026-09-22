/**
 * Change the email address on an Instagram account by navigating to Accounts Center, adding a new contact email, and verifying it with a confirmation code..
 * Compiled from the recording "instagram-change-email". Edit freely: the outline was the
 * source until this file was written; from here on this file is.
 *
 * Secrets (set as env, see SecretSource): code.
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
  newEmail: z.string().min(1).describe("Enter email"), // e.g. "william@wrenautomation.com"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  secrets: SecretSource;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

export type OpenAccountsCenterInput = Record<string, never>;

const openAccountsCenterFlow = defineFlow<OpenAccountsCenterInput, void>({
  site: "instagram",
  name: "open-accounts-center",
  async run(fp) {
    await fp.open("https://www.instagram.com/accounts/edit/");
    await fp.act(
      { kind: "click" },
      {
        role: "link",
        name: "Accounts Center Password, security, personal details, connected experiences, ad preferences",
      },
      {
        goal: "click Accounts Center Password, security, personal details, connected experiences, ad preferences",
      },
    ); // page.getByRole("link", { name: "Accounts Center Password, security, personal details, connected experiences, ad preferences", exact: true })
  },
});

const openAccountsCenter: Step<"open-accounts-center"> = {
  name: "open-accounts-center",
  async run({ fx, deps }) {
    await fx.run("browser open-accounts-center", () =>
      deps.browser.run(openAccountsCenterFlow, {}),
    );
    // TODO: prove the result through an API read where one exists.
    return done(
      "Open the Accounts Center from the Instagram account edit page to access contact info settings.",
    );
  },
};

export type OpenContactInfoInput = Record<string, never>;

const openContactInfoFlow = defineFlow<OpenContactInfoInput, void>({
  site: "instagram",
  name: "open-contact-info",
  async run(fp) {
    await fp.open("https://www.instagram.com/accounts/edit/");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^Contact info/" },
      { goal: "click Contact info jinwilliam.jin+wren@gmail.com" },
    ); // page.getByRole("button", { name: /^Contact info/ })
  },
});

const openContactInfo: Step<"open-contact-info"> = {
  name: "open-contact-info",
  async run({ fx, deps }) {
    await fx.run("browser open-contact-info", () => deps.browser.run(openContactInfoFlow, {}));
    // TODO: prove the result through an API read where one exists.
    return done("Click Contact info to view the current email address on file.");
  },
};

export type StartAddEmailInput = Record<string, never>;

const startAddEmailFlow = defineFlow<StartAddEmailInput, void>({
  site: "instagram",
  name: "start-add-email",
  async run(fp) {
    await fp.open("https://www.instagram.com/accounts/edit/");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Add new contact Collapsed" },
      { goal: "click Add new contact Collapsed" },
    ); // page.getByRole("button", { name: "Add new contact Collapsed", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Add email" },
      { goal: "click Add email" },
    ); // page.getByRole("button", { name: "Add email", exact: true })
  },
});

const startAddEmail: Step<"start-add-email"> = {
  name: "start-add-email",
  async run({ fx, deps }) {
    await fx.run("browser start-add-email", () => deps.browser.run(startAddEmailFlow, {}));
    // TODO: prove the result through an API read where one exists.
    return done(
      "Open the contact info sub-page and click Add email to begin adding a new email address.",
    );
  },
};

export interface AddAndVerifyEmailInput {
  newEmail: string;
  code: string;
}

const addAndVerifyEmailFlow = defineFlow<AddAndVerifyEmailInput, void>({
  site: "instagram",
  name: "add-and-verify-email",
  async run(fp, input) {
    await fp.open(
      "https://accountscenter.instagram.com/youraccount/contact_points/?entrypoint=profile_page&is_from_dialog=true",
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Add new contact Collapsed" },
      { goal: "click Add new contact Collapsed" },
    ); // page.getByRole("button", { name: "Add new contact Collapsed", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Add email" },
      { goal: "click Add email" },
    ); // page.getByRole("button", { name: "Add email", exact: true })
    await fp.act(
      { kind: "fill", value: input.newEmail },
      { role: "textbox", name: "Enter email" },
      { goal: "fill Enter email" },
    ); // page.getByRole("textbox", { name: "Enter email", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "checkbox", name: "wrenautomation Instagram" },
      { goal: "click wrenautomation Instagram" },
    ); // page.getByRole("checkbox", { name: "wrenautomation Instagram", exact: true })
    await fp.act({ kind: "click" }, { role: "button", name: "Next" }, { goal: "click Next" }); // page.getByRole("button", { name: "Next", exact: true })
    await fp.act(
      { kind: "fill", value: input.code },
      { role: "textbox", name: "Enter confirmation code" },
      { goal: "fill Enter confirmation code" },
    ); // page.getByRole("textbox", { name: "Enter confirmation code", exact: true })
    await fp.act({ kind: "click" }, { role: "button", name: "Next" }, { goal: "click Next" }); // page.getByRole("button", { name: "Next", exact: true })
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Close", nth: 1 },
      { goal: "click Close" },
    ); // page.getByRole("button", { name: "Close", exact: true })
  },
});

const addAndVerifyEmail: Step<"add-and-verify-email"> = {
  name: "add-and-verify-email",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate(
      "send",
      'Run "add-and-verify-email" (Enter the new email address, select it for the Instagram account, submit, enter the confirmation code sent to that email, confirm, and close the dialog.)?',
    );
    if (!answer.approved) return rejected(answer.note ?? "declined");
    // Outside fx.run on purpose: the journal must never hold it.
    const code = await deps.secrets.get("code");
    await fx.run("browser add-and-verify-email", () =>
      deps.browser.run(addAndVerifyEmailFlow, { newEmail: plan.newEmail, code }),
    );
    // TODO proof: GET https://accountscenter.instagram.com/youraccount/contact_points/ shows the new email listed as verified/confirmed on the account.
    return done(
      "Enter the new email address, select it for the Instagram account, submit, enter the confirmation code sent to that email, confirm, and close the dialog.",
    );
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "instagram-change-email",
  description:
    "Change the email address on an Instagram account by navigating to Accounts Center, adding a new contact email, and verifying it with a confirmation code.",
  plan: planSchema,
  steps: [openAccountsCenter, openContactInfo, startAddEmail, addAndVerifyEmail],
  emptyMemo: () => ({}),
});
