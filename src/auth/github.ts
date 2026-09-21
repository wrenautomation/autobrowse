/**
 * GitHub as an identity provider: the sign-in behind "Continue with GitHub".
 * Acts on whatever GitHub page the button landed on (never re-opens
 * /login: the `return_to` that brings the OAuth round trip back lives in
 * that URL). Password, then the authenticator code, then a device
 * verification code by email when GitHub asks for one, then the app's
 * authorize page the first time.
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";
import { registerProvider } from "./providers.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** GitHub's own steps between the password and the signed-in page. */
const STEP_URL = /github\.com\/sessions\/(two-factor|verified-device)/;

export async function signInToGithub(ctx: SignInContext): Promise<void> {
  const { fp, cred, code } = ctx;
  const site = "github";
  await fp.wait(SETTLE_MS);
  const username = { role: "textbox", name: "/username or email/i" } as const;
  const password = { role: "textbox", name: "/^password$/i" } as const;
  if (await fp.has(username, RENDER_MS)) {
    await fp.act({ kind: "fill", value: cred.username }, username, { goal: "type the username" });
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
  if (/incorrect username or password/i.test(text))
    throw new LoginFailed(site, "password rejected");

  // Two-factor: the authenticator code page, or the chooser that leads to it.
  const otp = { role: "textbox", name: "/authentication code|verification code|xxxxxx/i" } as const;
  if (/two-factor authentication/i.test(text)) {
    if (!(await fp.has(otp, RENDER_MS))) {
      const app = { text: "/authenticator app/i" } as const;
      if (!(await fp.has(app)))
        throw new LoginFailed(site, "two-factor page offers no authenticator app");
      await fp.act({ kind: "click" }, app, { goal: "use the authenticator app" });
      await fp.wait(SETTLE_MS);
    }
    if (!ctx.offers("totp"))
      throw new LoginFailed(site, "two-factor asks for an authenticator code; store totpSecret");
    await fp.act({ kind: "fill", value: await code("totp") }, otp, {
      goal: "type the authenticator code",
    });
    // GitHub submits six digits on its own; a Verify button is there on some pages.
    const verify = { role: "button", name: "/^verify$/i" } as const;
    if (await fp.has(verify, 2_000))
      await fp.act({ kind: "click" }, verify, { goal: "submit the code" });
    await fp.waitForUrl((u) => !/two-factor/.test(u), 15_000);
    text = await fp.text();
  }
  // A new device: GitHub emails a code before it lets the session through.
  if (/device verification/i.test(text)) {
    if (!ctx.offers("email"))
      throw new LoginFailed(
        site,
        "device verification emails a code; set CODES_INBOX or codesInbox",
      );
    await fp.act(
      { kind: "fill", value: await code("email", "github") },
      { role: "textbox", name: "/verification code|device verification/i" },
      { goal: "type the device verification code" },
    );
    const verify = { role: "button", name: "/^verify$/i" } as const;
    if (await fp.has(verify, 2_000))
      await fp.act({ kind: "click" }, verify, { goal: "submit the device code" });
    await fp.waitForUrl((u) => !/verified-device/.test(u), 15_000);
  }
  if (STEP_URL.test(fp.url()))
    throw new LoginFailed(site, `still on ${fp.url()} after the sign-in steps`);
  // First time through an OAuth app: its authorize page.
  const authorize = { role: "button", name: "/^authorize/i" } as const;
  if (/login\/oauth\/authorize/.test(fp.url()) && (await fp.has(authorize, RENDER_MS)))
    await fp.act({ kind: "click" }, authorize, { goal: "authorize the app" });
}

registerProvider({
  site: "github",
  host: /github\.com\/(login|sessions?|session)/,
  buttons: [
    { role: "button", name: "/github/i" },
    { role: "link", name: "/github/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with github/i" },
  ],
  signIn: signInToGithub,
});
