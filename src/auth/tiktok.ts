/**
 * TikTok's sign-in on whatever TikTok login page is open: the email/username
 * tab, password, "Log in"; then the code TikTok emails on a new device.
 * Its slider puzzle is a person's. Unverified until a credential exists
 * (from the public pages 2026-09-21).
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** The login pages, in any of their shapes: what `signInHere` acts on. */
export const TIKTOK_LOGIN_URL = /tiktok\.com\/login/;
/** The tab that takes a username and a password. */
const EMAIL_TAB = "https://www.tiktok.com/login/phone-or-email/email";

export async function signInToTiktok(ctx: SignInContext): Promise<void> {
  const { fp, cred, code } = ctx;
  const site = "tiktok";
  await fp.wait(SETTLE_MS);
  const username = { role: "textbox", name: "/email or username/i" } as const;
  const password = { role: "textbox", name: "/^password$/i" } as const;
  if (!(await fp.has(username, 3_000))) {
    // The chooser ("Use phone / email / username"), or the phone tab: go to the email tab.
    const useEmail = { text: "/use phone \\/ email \\/ username/i" } as const;
    if (await fp.has(useEmail))
      await fp.act({ kind: "click" }, useEmail, { goal: "email sign-in" });
    const emailTab = { role: "link", name: "/log in with email or username/i" } as const;
    if (await fp.has(emailTab, 3_000))
      await fp.act({ kind: "click" }, emailTab, { goal: "the email tab" });
    else if (!(await fp.has(username, 3_000))) await fp.open(EMAIL_TAB, { allowWall: true });
  }
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
  if (/doesn.t match our records|incorrect (account|password)|password is incorrect/i.test(text))
    throw new LoginFailed(site, "password rejected");
  if (/drag the slider|verify to continue|slide to verify|captcha/i.test(text))
    return fp.human("TikTok wants its slider puzzle solved");

  // A new device: the 6-digit code TikTok emails.
  const codeBox = {
    role: "textbox",
    name: "/6-digit code|verification code|enter code/i",
  } as const;
  if (
    /verification code|6-digit code|verify your account/i.test(text) &&
    (await fp.has(codeBox, RENDER_MS))
  ) {
    const kind = /authenticator/i.test(text) ? "totp" : "email";
    if (!ctx.offers(kind))
      throw new LoginFailed(
        site,
        `the check asks for a ${kind} code; ${kind === "totp" ? "store totpSecret" : "set codesInbox"}`,
      );
    await fp.act({ kind: "fill", value: await code(kind, "tiktok") }, codeBox, {
      goal: `type the ${kind} code`,
    });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^(next|confirm|submit|verify|continue)$/i" },
      { goal: "submit the code" },
    );
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/code (is )?(incorrect|invalid|expired)/i.test(text))
    throw new LoginFailed(site, "code rejected");
  if (!(await fp.waitForUrl((u) => !TIKTOK_LOGIN_URL.test(u), 15_000)))
    throw new LoginFailed(site, `still on ${fp.url()} after the sign-in steps`);
}
