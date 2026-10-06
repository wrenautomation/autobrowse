/**
 * LinkedIn's sign-in, on whatever LinkedIn login page is open: /login, or
 * the /uas/login?session_redirect=… an OAuth authorize URL lands a signed-out
 * profile on (that redirect must not be lost, so this never re-opens
 * /login). Email + password, then a checkpoint that asks for a code: the
 * authenticator app when a seed is stored, else the email code. A security
 * check (reCAPTCHA, on /login or a checkpoint) is the captcha solver's; only
 * one it can't pass, or a phone tap, is a person's. A restricted account
 * (LinkedIn wants an ID) stops the sign-in.
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** Login and its checkpoints; the URLs `signInHere` acts on. */
export const LINKEDIN_LOGIN_URL = /linkedin\.com\/(uas\/)?login|linkedin\.com\/checkpoint\//;
const CHECKPOINT_URL = /linkedin\.com\/checkpoint\//;
const SECURITY_CHECK = /security check|puzzle|captcha|verify you.re a person/i;

export async function signInToLinkedin(ctx: SignInContext): Promise<void> {
  const { fp, cred, code } = ctx;
  const site = "linkedin";
  await fp.wait(SETTLE_MS);
  const username = { role: "textbox", name: "/email or phone/i" } as const;
  const password = { role: "textbox", name: "/^password$/i" } as const;
  if (await fp.has(username, RENDER_MS)) {
    await fp.act({ kind: "fill", value: cred.username }, username, { goal: "type the email" });
    await fp.act({ kind: "fill", value: passwordOf(site, cred) }, password, {
      goal: "type the password",
    });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^sign in$/i" },
      { goal: "submit the sign-in form" },
    );
    await fp.wait(SETTLE_MS);
  }
  let text = await fp.text();
  if (SECURITY_CHECK.test(text)) {
    const got = await fp.captcha();
    if (!got.solved) return fp.human(`LinkedIn's security check: ${got.reason}`);
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (
    /login-restriction/.test(fp.url()) ||
    /account has been (temporarily )?restricted/i.test(text)
  )
    throw new LoginFailed(site, "account restricted: LinkedIn asks for a government ID");
  if (/wrong email or password|not the right password|couldn.t find a linkedin account/i.test(text))
    throw new LoginFailed(site, "password rejected");

  // The checkpoint: a code box (authenticator or email), or something only a person can do.
  const otp = { role: "textbox", name: "/code/i" } as const;
  if (CHECKPOINT_URL.test(fp.url()) || /verification code|enter the code/i.test(text)) {
    if (!(await fp.has(otp, RENDER_MS))) {
      if (SECURITY_CHECK.test(text))
        return fp.human("LinkedIn wants a security check the solver couldn't pass");
      throw new LoginFailed(site, `checkpoint without a code box: ${fp.url()}`);
    }
    // The page says where the code comes from; the credential says what we can read.
    const kind = /authenticator app/i.test(text)
      ? "totp"
      : /text message|sms|phone number/i.test(text)
        ? "sms"
        : "email";
    if (!ctx.offers(kind))
      throw new LoginFailed(
        site,
        `the checkpoint asks for a ${kind} code; ${kind === "totp" ? "store totpSecret" : "set codesInbox"}`,
      );
    await fp.act({ kind: "fill", value: await code(kind, "linkedin") }, otp, {
      goal: `type the ${kind} code`,
    });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^(submit|verify|continue)$/i" },
      { goal: "submit the code" },
    );
    await fp.waitForUrl((u) => !CHECKPOINT_URL.test(u), 15_000);
    text = await fp.text();
  }
  if (/wrong code|incorrect code|code you entered/i.test(text))
    throw new LoginFailed(site, "code rejected");
  if (!(await fp.waitForUrl((u) => !LINKEDIN_LOGIN_URL.test(u), 15_000)))
    throw new LoginFailed(site, `still on ${fp.url()} after the sign-in steps`);
}
