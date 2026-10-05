/**
 * Microsoft as an identity provider: the sign-in behind "Sign in with
 * Microsoft" (login.microsoftonline.com, login.live.com). Acts on the page
 * the button landed on, until the page leaves Microsoft's host. Usually
 * email → password → a second step when asked (an authenticator code when
 * the account has one, else the phone's approve prompt through `notify`)
 * → "Stay signed in?" → the app's "Permissions requested" the first time.
 */
import { type Screen, walk } from "../browser/screens.js";
import { LoginFailed, passwordOf, type SignInContext } from "./login.js";
import { registerProvider } from "./providers.js";

/** How long a person gets to approve on their phone. */
const PROMPT_MS = 180_000;
export const MICROSOFT_HOST = /login\.(microsoftonline|live|microsoft)\.com/;

const EMAIL = { role: "textbox", name: "/email|phone|skype|sign in/i" } as const;
const PASSWORD = { role: "textbox", name: "/password/i" } as const;
const CODE = { role: "textbox", name: "/code/i" } as const;
/** On the phone-prompt page: the way to a code instead. */
const OTHER_WAY = {
  text: "/use a verification code|i can.t use my microsoft authenticator|sign in another way/i",
} as const;
const VIA_CODE = { text: "/verification code/i" } as const;
const USE_PASSWORD = { text: "/use your password/i" } as const;

/**
 * A walk (designs/2026-09-27-screens.md): Microsoft shows these pages in
 * an order that depends on the account and the browser (a picker or not,
 * a phone prompt or a code, "Stay signed in?" or not), so each is a screen
 * and a page it does not know goes down the learned → reader ladder.
 */
export async function signInToMicrosoft(ctx: SignInContext): Promise<void> {
  const { cred } = ctx;
  const site = "microsoft";
  const fail = (why: string): never => {
    throw new LoginFailed(site, why);
  };
  const click = (name: string, goal: string) => (c: SignInContext) =>
    c.fp.act({ kind: "click" }, { role: "button", name }, { goal });
  const screens: Screen<SignInContext>[] = [
    {
      name: "left",
      looks: "the app the sign-in was for, off Microsoft's sign-in host",
      is: async ({ fp }) => !MICROSOFT_HOST.test(fp.url()),
      goal: true,
    },
    {
      name: "unknown account",
      looks: "Microsoft saying it has no such account",
      at: MICROSOFT_HOST,
      says: /couldn.t find an account|that microsoft account doesn.t exist/i,
      act: async () => fail("unknown account"),
    },
    {
      name: "rejected",
      looks: "Microsoft saying the password is wrong",
      at: MICROSOFT_HOST,
      says: /password is incorrect|account or password is incorrect/i,
      act: async () => fail("password rejected"),
    },
    {
      name: "stay signed in",
      looks: "'Stay signed in?' with Yes and No",
      at: MICROSOFT_HOST,
      says: /stay signed in/i,
      // Keeps the profile's session.
      act: click("/^yes$/i", "stay signed in"),
    },
    {
      name: "permissions",
      looks: "an app's 'Permissions requested' page, the first time through it",
      at: MICROSOFT_HOST,
      says: /permissions requested/i,
      act: click("/^accept$/i", "accept the app's permissions"),
    },
    {
      name: "pick an account",
      looks: "a picker of accounts the browser knows, and 'Use another account'",
      at: MICROSOFT_HOST,
      says: /pick an account/i,
      async act({ fp }) {
        const mine = { text: cred.username } as const;
        await fp.act(
          { kind: "click" },
          (await fp.has(mine)) ? mine : { text: "/use another account/i" },
          { goal: "pick the account" },
        );
      },
    },
    {
      name: "code",
      looks: "a box for the authenticator app's code",
      at: MICROSOFT_HOST,
      shows: [CODE],
      async act({ fp, code, offers }) {
        if (!offers("totp")) fail("second step asks for a code; store totpSecret");
        await fp.act({ kind: "fill", value: await code("totp") }, CODE, {
          goal: "type the authenticator code",
        });
        await fp.act(
          { kind: "click" },
          { role: "button", name: "/^verify$/i" },
          {
            goal: "submit the code",
          },
        );
      },
    },
    {
      name: "password instead",
      looks: "a passwordless prompt (approve on the phone, or a code) offering 'Use your password'",
      at: MICROSOFT_HOST,
      shows: [USE_PASSWORD],
      hides: [PASSWORD],
      // The password needs no person; the phone does.
      act: ({ fp }) =>
        fp.act({ kind: "click" }, USE_PASSWORD, { goal: "use the password instead" }),
    },
    {
      name: "second step",
      looks: "a second step: verify your identity, or approve on the phone",
      at: MICROSOFT_HOST,
      says: /verify your identity|enter code|approve sign in request|approve a request|open your authenticator app/i,
      async act(c) {
        const { fp } = c;
        // An authenticator code when the account has one; else the phone.
        if (c.offers("totp")) {
          if (await fp.has(OTHER_WAY))
            await fp.act({ kind: "click" }, OTHER_WAY, { goal: "choose the verification code" });
          if (await fp.has(VIA_CODE, 5_000))
            return fp.act({ kind: "click" }, VIA_CODE, { goal: "use a verification code" });
          return fail("no place to type the authenticator code");
        }
        const text = await fp.text();
        if (!/approve sign in request|approve a request|open your authenticator app/i.test(text))
          fail("second step asks for a code; store totpSecret");
        if (!c.notify) fail("sign-in wants the phone's approval; no phone is linked");
        const number = /\b(\d{2})\b/.exec(text)?.[1];
        await c.notify?.(
          `Microsoft sign-in for ${cred.username}: approve it in the Authenticator app${number ? ` (number ${number})` : ""}`,
        );
        if (
          !(await fp.waitForUrl(
            (u) => !MICROSOFT_HOST.test(u) || /kmsi|consent/.test(u),
            PROMPT_MS,
          ))
        )
          fail("the phone did not approve in time");
      },
    },
    {
      name: "password",
      looks: "the password box",
      at: MICROSOFT_HOST,
      shows: [PASSWORD],
      async act({ fp }) {
        await fp.act({ kind: "fill", value: passwordOf(site, cred) }, PASSWORD, {
          goal: "type the password",
        });
        await fp.act(
          { kind: "click" },
          { role: "button", name: "/^sign in$/i" },
          {
            goal: "submit the password",
          },
        );
      },
    },
    {
      name: "email",
      looks: "the email, phone or Skype box",
      at: MICROSOFT_HOST,
      shows: [EMAIL],
      async act({ fp }) {
        await fp.act({ kind: "fill", value: cred.username }, EMAIL, { goal: "type the email" });
        await fp.act(
          { kind: "click" },
          { role: "button", name: "/^next$/i" },
          {
            goal: "continue past the email",
          },
        );
      },
    },
  ];
  await walk(ctx, { site, name: "sign-in", goal: "signed in with Microsoft", fail, screens });
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
