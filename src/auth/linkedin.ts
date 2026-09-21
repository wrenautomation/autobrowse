/**
 * LinkedIn's sign-in, on whatever LinkedIn login page is open: /login, or
 * the /uas/login?session_redirect=… an OAuth authorize URL lands a signed-out
 * profile on (that redirect must not be lost, so this never re-opens
 * /login). Email + password, then a checkpoint that asks for a code: the
 * authenticator app when a seed is stored, else the email code. A checkpoint
 * that wants a puzzle or a phone tap is a person's. Unverified until a
 * LinkedIn credential exists (mapped from the public pages 2026-09-21).
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** Login and its checkpoints; the URLs `signInHere` acts on. */
export const LINKEDIN_LOGIN_URL = /linkedin\.com\/(uas\/)?login|linkedin\.com\/checkpoint\//;
const CHECKPOINT_URL = /linkedin\.com\/checkpoint\//;

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
  if (/wrong email or password|not the right password|couldn.t find a linkedin account/i.test(text))
    throw new LoginFailed(site, "password rejected");

  // The checkpoint: a code box (authenticator or email), or something only a person can do.
  const otp = { role: "textbox", name: "/code/i" } as const;
  if (CHECKPOINT_URL.test(fp.url()) || /verification code|enter the code/i.test(text)) {
    if (!(await fp.has(otp, RENDER_MS))) {
      if (/security check|puzzle|captcha|verify you.re a person/i.test(text))
        return fp.human("LinkedIn wants a security check only a person can pass");
      throw new LoginFailed(site, `checkpoint without a code box: ${fp.url()}`);
    }
    const kind = ctx.offers("totp") ? "totp" : "email";
    if (!ctx.offers(kind))
      throw new LoginFailed(
        site,
        "the checkpoint asks for a code; store totpSecret or set codesInbox",
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
