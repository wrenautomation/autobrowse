/**
 * Make a Reddit account on www.reddit.com/register/ with an email, a
 * username and a minted password, confirming the email with the code Reddit
 * sends. Shaped by the agent run that made reddit@alt on 2026-10-02: a
 * checkbox captcha on open (`fp.open` solves it), email → "Continue", the
 * "Verification code" field, then username + password → "Continue" makes the
 * account; the gender and interests dialogs after it are left, not answered.
 * The browser must run as the new account's key (a sibling account's
 * profile answers "already signed in"). Run it on a home IP: Reddit
 * bot-checks a datacenter one.
 *
 * Secrets (set as env, see SecretSource): email, password, code. The password
 * is minted and stored under `reddit@<label>` by `autobrowse signup reddit
 * --email <address>` before this runs, so a stalled signup still has it.
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
  username: z
    .string()
    .regex(/^[A-Za-z0-9_-]{3,20}$/, "3 to 20 letters, digits, _ or -")
    .describe("Username"), // e.g. "quiet_ops_wren"
});
export type Plan = z.infer<typeof planSchema>;

export interface Deps {
  browser: FlowRunner;
  secrets: SecretSource;
}

/** What steps pass forward; nothing yet. */
export type Memo = Record<string, unknown>;

type Step<S extends string> = StepDef<Plan, Deps, Memo, S>;

const REGISTER = "https://www.reddit.com/register/";
const OLD = "https://old.reddit.com";

/** The little of the DOM the page script touches; the project compiles without lib dom. */
interface El {
  textContent: string | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;
const RENDER_MS = 15_000;

export interface SubmitEmailInput {
  email: string;
}

/** The dialog's first page: the address, then Continue; Reddit then mails a code. */
const submitEmailFlow = defineFlow<SubmitEmailInput, void>({
  site: "reddit",
  name: "signup-email",
  async run(fp, input) {
    await fp.open(REGISTER);
    const email = { role: "textbox" as const, name: "/^email/i" };
    if (!(await fp.has(email, RENDER_MS))) return fp.human(`reddit: no email field at ${fp.url()}`);
    await fp.act({ kind: "fill", value: input.email }, email, { goal: "type the email" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^continue$/i" },
      {
        goal: "continue past the email",
      },
    );
  },
});

export interface VerifyEmailInput {
  code: string;
}

/** The six-digit code from the inbox; a dialog that asks for none is skipped. */
const verifyEmailFlow = defineFlow<VerifyEmailInput, { asked: boolean }>({
  site: "reddit",
  name: "signup-verify",
  async run(fp, input) {
    const code = { role: "textbox" as const, name: "/code/i" };
    if (!(await fp.has(code, RENDER_MS))) return { asked: false };
    await fp.act({ kind: "fill", value: input.code }, code, { goal: "type the code" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^continue$/i" },
      {
        goal: "continue past the code",
      },
    );
    return { asked: true };
  },
});

export interface CreateAccountInput {
  username: string;
  password: string;
}

/** Username and password, then Continue: this click makes the account. The tail dialogs are skipped. */
const createAccountFlow = defineFlow<CreateAccountInput, { username: string }>({
  site: "reddit",
  name: "signup-create",
  async run(fp, input) {
    const username = { role: "textbox" as const, name: "/^username/i" };
    if (!(await fp.has(username, RENDER_MS)))
      return fp.human(`reddit: no username field at ${fp.url()}`);
    await fp.act({ kind: "fill", value: input.username }, username, { goal: "type the username" });
    await fp.act(
      { kind: "fill", value: input.password },
      { role: "textbox", name: "/^password/i" },
      { goal: "type the password" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^continue$/i" },
      {
        goal: "make the account",
        irreversible: true,
      },
    );
    if (await fp.has({ role: "textbox", name: "/^username/i" }, 5_000))
      return fp.human(`reddit: the signup stayed on the username page (taken, or a bot check)`);
    // The account exists once that page is gone. The tail (gender, then interests,
    // which refuses to continue without a pick) is optional: leaving answers it.
    // Old Reddit's header names the signed-in account, which may not be the
    // username asked for: Reddit keeps its own suggestion when the fill is late.
    await fp.open(`${OLD}/`);
    const name = await fp.page.evaluate(
      () => [...document.querySelectorAll("#header .user a")][0]?.textContent?.trim() ?? "",
    );
    if (!name) return fp.human(`reddit: the signup ended signed out (${fp.url()})`);
    return { username: name };
  },
});

const submitEmail: Step<"submit-email"> = {
  name: "submit-email",
  async run({ fx, deps }) {
    // Outside fx.run on purpose: the journal must never hold it.
    const email = await deps.secrets.get("email");
    await fx.run("browser signup-email", () => deps.browser.run(submitEmailFlow, { email }));
    return done("Typed the address and asked Reddit for its code.");
  },
};

const verifyEmail: Step<"verify-email"> = {
  name: "verify-email",
  async run({ fx, deps }) {
    // Outside fx.run on purpose: the journal must never hold it.
    const code = await deps.secrets.get("code");
    const out = await fx.run("browser signup-verify", () =>
      deps.browser.run(verifyEmailFlow, { code }),
    );
    return done(out?.asked ? "Entered the emailed code." : "Reddit asked for no code.");
  },
};

const createAccount: Step<"create-account"> = {
  name: "create-account",
  irreversible: true,
  async run({ fx, deps, plan, gate }) {
    const answer = gate("send", `Make the Reddit account u/${plan.username}?`);
    if (!answer.approved) return rejected(answer.note ?? "declined");
    // Outside fx.run on purpose: the journal must never hold it.
    const password = await deps.secrets.get("password");
    const made = await fx.run("browser signup-create", () =>
      deps.browser.run(createAccountFlow, { username: plan.username, password }),
    );
    const name = made?.username ?? plan.username;
    return done(
      name === plan.username
        ? `u/${name} exists and is signed in.`
        : `u/${name} exists and is signed in (Reddit kept its own name, not u/${plan.username}).`,
    );
  },
};

export const workflow = defineWorkflow<Deps, Memo>()({
  name: "signup-reddit",
  description:
    "Make a Reddit account with an email, a username and a minted password, confirming the emailed code.",
  plan: planSchema,
  steps: [submitEmail, verifyEmail, createAccount],
  emptyMemo: () => ({}),
});
