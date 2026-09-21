/**
 * X's sign-in on whatever X login page is open (the OAuth authorize page
 * shows it first; never re-opened). One field at a time: username, then —
 * on an unfamiliar login — the phone or username again, then the password,
 * then the verification code: the authenticator when a seed is stored,
 * else the code X texts or emails. The "Arkose" puzzle is a person's.
 * Unverified until a credential exists (from the public pages 2026-09-22).
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** Login flow and its checks: what `signInHere` acts on. */
export const X_LOGIN_URL = /(x|twitter)\.com\/(i\/flow\/login|login|account\/access)/;
const NEXT = { role: "button", name: "/^next$/i" } as const;

export async function signInToX(ctx: SignInContext): Promise<void> {
  const { fp, cred, code } = ctx;
  const site = "x";
  await fp.wait(SETTLE_MS);
  const username = { role: "textbox", name: "/phone, email,? (address,)? ?or username/i" } as const;
  const password = { role: "textbox", name: "/^password$/i" } as const;
  if (await fp.has(username, RENDER_MS)) {
    await fp.act({ kind: "fill", value: cred.username }, username, { goal: "type the username" });
    await fp.act({ kind: "click" }, NEXT, { goal: "next" });
    await fp.wait(SETTLE_MS);
  }
  // "Enter your phone number or username": the unusual-activity check wants the handle again.
  const again = { role: "textbox", name: "/phone number or username/i" } as const;
  if (await fp.has(again, 3_000)) {
    await fp.act({ kind: "fill", value: cred.username }, again, {
      goal: "type the username again",
    });
    await fp.act({ kind: "click" }, NEXT, { goal: "next" });
    await fp.wait(SETTLE_MS);
  }
  if (await fp.has(password, RENDER_MS)) {
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
    /wrong password|password is incorrect|could not find your account|we couldn.t find/i.test(text)
  )
    throw new LoginFailed(site, "password rejected");

  const codeBox = { role: "textbox", name: "/verification code|^code$/i" } as const;
  if (/verification code|authentication app|confirmation code/i.test(text)) {
    if (!(await fp.has(codeBox, RENDER_MS))) {
      if (/puzzle|arkose|suspicious|locked|verify your identity/i.test(text))
        return fp.human("X wants a check only a person can pass");
      throw new LoginFailed(site, `a check without a code box: ${fp.url()}`);
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
    await fp.act({ kind: "click" }, NEXT, { goal: "submit the code" });
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/code (is|was) (incorrect|invalid)|incorrect code|try again/i.test(text))
    throw new LoginFailed(site, "code rejected");
  if (/puzzle|arkose|suspicious|locked/i.test(text))
    return fp.human("X wants a check only a person can pass");
  if (!(await fp.waitForUrl((u) => !X_LOGIN_URL.test(u), 15_000)))
    throw new LoginFailed(site, `still on ${fp.url()} after the sign-in steps`);
}
