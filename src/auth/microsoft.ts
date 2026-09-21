/**
 * Microsoft as an identity provider: the sign-in behind "Sign in with
 * Microsoft" (login.microsoftonline.com, login.live.com). Acts on the page
 * the button landed on. Email → Next → password → Sign in → a second step
 * when asked (an authenticator code when the account has one, else the
 * phone's approve prompt through `notify`) → "Stay signed in?" → the app's
 * "Permissions requested" page the first time.
 */
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";
import { registerProvider } from "./providers.js";

const SETTLE_MS = 1_500;
const RENDER_MS = 8_000;
/** How long a person gets to approve on their phone. */
const PROMPT_MS = 180_000;
export const MICROSOFT_HOST = /login\.(microsoftonline|live|microsoft)\.com/;

export async function signInToMicrosoft(ctx: SignInContext): Promise<void> {
  const { fp, cred, code } = ctx;
  const site = "microsoft";
  await fp.wait(SETTLE_MS);
  let text = await fp.text();
  // A picker of accounts the browser knows: ours, or "Use another account".
  if (/pick an account/i.test(text)) {
    const mine = { text: cred.username } as const;
    await fp.act(
      { kind: "click" },
      (await fp.has(mine)) ? mine : { text: "/use another account/i" },
      { goal: "pick the account" },
    );
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  const email = { role: "textbox", name: "/email|phone|skype|sign in/i" } as const;
  if (await fp.has(email, RENDER_MS)) {
    await fp.act({ kind: "fill", value: cred.username }, email, { goal: "type the email" });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^next$/i" },
      { goal: "continue past the email" },
    );
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/couldn.t find an account|that microsoft account doesn.t exist/i.test(text))
    throw new LoginFailed(site, "unknown account");
  const password = { role: "textbox", name: "/password/i" } as const;
  if (await fp.has(password, RENDER_MS)) {
    await fp.act({ kind: "fill", value: passwordOf(site, cred) }, password, {
      goal: "type the password",
    });
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^sign in$/i" },
      { goal: "submit the password" },
    );
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  if (/password is incorrect|account or password is incorrect/i.test(text))
    throw new LoginFailed(site, "password rejected");

  // Second step. An authenticator code when the account has one; else the phone.
  if (/verify your identity|enter code|approve sign in request|approve a request/i.test(text)) {
    const codeBox = { role: "textbox", name: "/code/i" } as const;
    if (ctx.offers("totp")) {
      if (!(await fp.has(codeBox, 2_000))) {
        // Offered the phone prompt first: ask for the code way instead.
        const other = {
          text: "/use a verification code|i can.t use my microsoft authenticator|sign in another way/i",
        } as const;
        if (await fp.has(other)) {
          await fp.act({ kind: "click" }, other, { goal: "choose the verification code" });
          await fp.wait(SETTLE_MS);
          const viaCode = { text: "/verification code/i" } as const;
          if (await fp.has(viaCode))
            await fp.act({ kind: "click" }, viaCode, { goal: "use a verification code" });
          await fp.wait(SETTLE_MS);
        }
      }
      if (!(await fp.has(codeBox, RENDER_MS)))
        throw new LoginFailed(site, "no place to type the authenticator code");
      await fp.act({ kind: "fill", value: await code("totp") }, codeBox, {
        goal: "type the authenticator code",
      });
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/^verify$/i" },
        { goal: "submit the code" },
      );
    } else if (
      /approve sign in request|approve a request|open your authenticator app/i.test(text)
    ) {
      const number = /\b(\d{2})\b/.exec(text)?.[1];
      if (!ctx.notify)
        throw new LoginFailed(site, "sign-in wants the phone's approval; no phone is linked");
      await ctx.notify(
        `Microsoft sign-in for ${cred.username}: approve it in the Authenticator app${number ? ` (number ${number})` : ""}`,
      );
      if (
        !(await fp.waitForUrl((u) => !MICROSOFT_HOST.test(u) || /kmsi|consent/.test(u), PROMPT_MS))
      )
        throw new LoginFailed(site, "the phone did not approve in time");
    } else {
      throw new LoginFailed(site, "second step asks for a code; store totpSecret");
    }
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  // "Stay signed in?" keeps the profile's session.
  if (/stay signed in/i.test(text)) {
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^yes$/i" },
      { goal: "stay signed in" },
    );
    await fp.wait(SETTLE_MS);
    text = await fp.text();
  }
  // First time through an app: its permissions page.
  if (/permissions requested/i.test(text)) {
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^accept$/i" },
      { goal: "accept the app's permissions" },
    );
    await fp.wait(SETTLE_MS);
  }
  if (MICROSOFT_HOST.test(fp.url()) && (await fp.has(password, 1_000)))
    throw new LoginFailed(site, `still on ${fp.url()} after the sign-in steps`);
}

registerProvider({
  site: "microsoft",
  host: MICROSOFT_HOST,
  buttons: [
    { role: "button", name: "/microsoft/i" },
    { role: "link", name: "/microsoft/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with microsoft/i" },
  ],
  signIn: signInToMicrosoft,
});
