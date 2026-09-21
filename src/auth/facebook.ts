/**
 * Facebook's sign-in on whatever Facebook login page is open (the OAuth
 * dialog shows it under the authorize URL; never re-opened, so `next`
 * survives). Email + password, then the two-factor code: the authenticator
 * when a seed is stored, else the code Facebook texts or emails. The "save
 * browser" and "trust this device" prompts are declined. Unverified until
 * a credential exists (from the public pages 2026-09-22).
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** Login, two-factor and checkpoint pages: what `signInHere` acts on. */
export const FACEBOOK_LOGIN_URL =
  /facebook\.com\/(login|checkpoint|two_step_verification|two_factor|recover)/;

export async function signInToFacebook(ctx: SignInContext): Promise<void> {
  const { fp, cred, code } = ctx;
  const site = "facebook";
  await fp.wait(SETTLE_MS);
  const email = {
    role: "textbox",
    name: "/email( address)? or phone( number)?|^email$/i",
  } as const;
  const password = { role: "textbox", name: "/^password$/i" } as const;
  if (await fp.has(email, RENDER_MS)) {
    await fp.act({ kind: "fill", value: cred.username }, email, { goal: "type the email" });
    await fp.act({ kind: "fill", value: passwordOf(site, cred) }, password, {
      goal: "type the password",
    });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^log in$/i" },
      { goal: "submit the sign-in form" },
    );
    await fp.wait(SETTLE_MS);
  }
  let text = await fp.text();
  if (
    /password (you.ve entered|that you.ve entered) is incorrect|wrong credentials|invalid (username|email)/i.test(
      text,
    )
  )
    throw new LoginFailed(site, "password rejected");

  // Two-factor: the authenticator app, or the code texted/emailed.
  const codeBox = { role: "textbox", name: "/^code$|login code|6-digit|security code/i" } as const;
  if (
    /checkpoint|two_step|two_factor/.test(fp.url()) ||
    /two-factor|login code|6-digit code/i.test(text)
  ) {
    if (!(await fp.has(codeBox, RENDER_MS))) {
      if (/confirm your identity|video selfie|upload (a )?photo|locked|suspicious/i.test(text))
        return fp.human("Facebook wants a check only a person can pass");
      throw new LoginFailed(site, `a checkpoint without a code box: ${fp.url()}`);
    }
    const kind = /authentication app|authenticator/i.test(text)
      ? "totp"
      : /text(ed)?|sms|phone/i.test(text)
        ? "sms"
        : "email";
    if (!ctx.offers(kind))
      throw new LoginFailed(
        site,
        `the check asks for a ${kind} code; ${kind === "totp" ? "store totpSecret" : kind === "sms" ? "set a phone" : "set codesInbox"}`,
      );
    await fp.act({ kind: "fill", value: await code(kind, site) }, codeBox, {
      goal: `type the ${kind} code`,
    });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^(continue|submit|next|confirm)$/i" },
      { goal: "submit the code" },
    );
    await fp.waitForUrl((u) => !/checkpoint|two_step|two_factor/.test(u), 15_000);
    text = await fp.text();
  }
  if (/code (you entered )?(is|was) (incorrect|invalid)|incorrect code/i.test(text))
    throw new LoginFailed(site, "code rejected");
  // "Save browser?" / "Trust this device?": no.
  for (const decline of [/^(don.t save|not now|skip)$/i, /^(don.t save|not now|skip)$/i]) {
    const button = { role: "button", name: String(decline) } as const;
    if (await fp.has(button, 3_000)) await fp.act({ kind: "click" }, button, { goal: "not now" });
  }
  if (!(await fp.waitForUrl((u) => !FACEBOOK_LOGIN_URL.test(u), 15_000)))
    throw new LoginFailed(site, `still on ${fp.url()} after the sign-in steps`);
}
