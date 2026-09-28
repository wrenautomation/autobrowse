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

  // Two-factor. Never GitHub Mobile (William, 09-27): the authenticator key
  // when one is stored, else a code by text or email, picked under "More options".
  if (/two-factor/.test(fp.url())) {
    await twoFactor(ctx);
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

/** The two-factor ways GitHub offers, in the order we take them, and the code each needs. */
const WAYS = [
  { kind: "totp", choice: { text: "/authenticator app/i" }, url: /two-factor(\/app)?$/ },
  { kind: "sms", choice: { text: "/text message|sms/i" }, url: /two-factor\/sms$/ },
  { kind: "email", choice: { text: "/email/i" }, url: /two-factor\/email$/ },
] as const;

async function twoFactor(ctx: SignInContext): Promise<void> {
  const { fp, code } = ctx;
  const site = "github";
  const otp = { role: "textbox", name: "/code|xxxxxx/i" } as const;
  const usable = WAYS.filter((w) => ctx.offers(w.kind));
  if (usable.length === 0)
    throw new LoginFailed(
      site,
      "two-factor needs an authenticator key (creds totp), a phone for texts, or a readable codes inbox",
    );
  // Already on a way we can answer (the page GitHub opened with)?
  const path = new URL(fp.url()).pathname;
  let way = usable.find((w) => w.url.test(path));
  if (!way) {
    const more = { role: "button", name: "/more options/i" } as const;
    if (await fp.has(more, RENDER_MS))
      await fp.act({ kind: "click" }, more, { goal: "show the other two-factor ways" });
    for (const w of usable)
      if (await fp.has(w.choice, 2_000)) {
        await fp.act({ kind: "click" }, w.choice, { goal: `use a ${w.kind} code` });
        way = w;
        break;
      }
  }
  if (!way)
    throw new LoginFailed(
      site,
      `two-factor offers none of ${usable.map((w) => w.kind).join(", ")} (never GitHub Mobile)`,
    );
  await fp.wait(SETTLE_MS);
  // A text or email is sent on a button press on some pages.
  const send = { role: "button", name: "/send|resend/i" } as const;
  if (way.kind !== "totp" && (await fp.has(send, 2_000)))
    await fp.act({ kind: "click" }, send, { goal: `send the ${way.kind} code` });
  await fp.act({ kind: "fill", value: await code(way.kind, "github") }, otp, {
    goal: `type the ${way.kind} code`,
  });
  // GitHub submits six digits on its own; a Verify button is there on some pages.
  const verify = { role: "button", name: "/^verify$/i" } as const;
  if (await fp.has(verify, 2_000))
    await fp.act({ kind: "click" }, verify, { goal: "submit the code" });
  if (!(await fp.waitForUrl((u) => !/two-factor/.test(u), 15_000)))
    throw new LoginFailed(site, `still on ${fp.url()} after the ${way.kind} code`);
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
