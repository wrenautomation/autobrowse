/**
 * Instagram's sign-in on whatever Instagram login page is open (its OAuth
 * dialog shows the login under the authorize URL; never re-opened, so the
 * `next` in that URL survives). Username + password, then the security
 * code: the authenticator when a seed is stored, else the code Instagram
 * emails on an unfamiliar login. The "save login" and "notifications"
 * prompts are declined. Unverified until a credential exists (from the
 * public pages 2026-09-21).
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** Login, two-factor and the checkpoint challenges: what `signInHere` acts on. */
export const INSTAGRAM_LOGIN_URL = /instagram\.com\/accounts\/login|instagram\.com\/challenge/;

export async function signInToInstagram(ctx: SignInContext): Promise<void> {
  const { fp, cred, code } = ctx;
  const site = "instagram";
  await fp.wait(SETTLE_MS);
  const username = { role: "textbox", name: "/phone number, username,? or email/i" } as const;
  const password = { role: "textbox", name: "/^password$/i" } as const;
  if (await fp.has(username, RENDER_MS)) {
    await fp.act({ kind: "fill", value: cred.username }, username, { goal: "type the username" });
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
    /password was incorrect|incorrect password|user not found|couldn.t find your account/i.test(
      text,
    )
  )
    throw new LoginFailed(site, "password rejected");

  // The security code: the authenticator app, or the code emailed on an unusual login.
  const codeBox = { role: "textbox", name: "/security code|confirmation code|^code$/i" } as const;
  if (/two_factor|challenge/.test(fp.url()) || /security code|unusual login/i.test(text)) {
    const send = { role: "button", name: "/send (security )?code/i" } as const;
    if (await fp.has(send)) {
      await fp.act({ kind: "click" }, send, { goal: "have the code sent" });
      await fp.wait(SETTLE_MS);
      text = await fp.text();
    }
    if (!(await fp.has(codeBox, RENDER_MS))) {
      if (/suspicious|confirm it.s you|video selfie|captcha/i.test(text))
        return fp.human("Instagram wants a check only a person can pass");
      throw new LoginFailed(site, `a challenge without a code box: ${fp.url()}`);
    }
    const kind = /authentication app|authenticator/i.test(text) ? "totp" : "email";
    if (!ctx.offers(kind))
      throw new LoginFailed(
        site,
        `the check asks for a ${kind} code; ${kind === "totp" ? "store totpSecret" : "set codesInbox"}`,
      );
    await fp.act({ kind: "fill", value: await code(kind, "instagram") }, codeBox, {
      goal: `type the ${kind} code`,
    });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^(confirm|submit|next|continue)$/i" },
      { goal: "submit the code" },
    );
    await fp.waitForUrl((u) => !/two_factor|challenge/.test(u), 15_000);
    text = await fp.text();
  }
  if (/code you entered|incorrect code|check the code/i.test(text))
    throw new LoginFailed(site, "code rejected");
  // "Save your login info?" and "Turn on notifications": no, and no.
  for (const decline of [/^not now$/i, /^not now$/i]) {
    const button = { role: "button", name: String(decline) } as const;
    if (await fp.has(button, 3_000)) await fp.act({ kind: "click" }, button, { goal: "not now" });
  }
  if (!(await fp.waitForUrl((u) => !INSTAGRAM_LOGIN_URL.test(u), 15_000)))
    throw new LoginFailed(site, `still on ${fp.url()} after the sign-in steps`);
}
