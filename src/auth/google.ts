/**
 * Google's own sign-in as screens. Its pages come in any order (the admin
 * console, the popup behind another site's "Google" button, a security
 * re-check, One Tap), so the walk names the page it is on, does the one
 * thing that page wants, and looks again until the page is off
 * accounts.google.com. A page no screen knows goes down the runner's
 * ladder (learned screens, the reader) and then fails as `LoginFailed`,
 * so the account's next sign-in method gets its turn.
 *
 * The second step is chosen by what this system can answer (mapped 2026-09-19):
 *   1. authenticator code   (our TOTP seed)          "Get a verification code from the Google Authenticator app"
 *   2. SMS code             (paired phone or Twilio)  "Get a verification code at (•••) •••-••18"
 *   3. device prompt        (a person's phone)        "Tap Yes on your phone or tablet", after a note to that phone
 * A passkey we enrolled goes first when Google offers it. Google shows the
 * steps as links on challenge/selection; "Try another way" opens it.
 */
import type { FlowPage } from "../browser/flow.js";
import type { Hints } from "../browser/locate.js";
import { type Screen, type Walk, walk } from "../browser/screens.js";
import { LoginFailed, passwordOf, type SignInContext, serially } from "./login.js";
import { registerProvider } from "./providers.js";

const SETTLE_MS = 1_500;
/** How long a page gets to render a control before it counts as absent. */
const RENDER_MS = 8_000;
/** How long a person gets to tap Yes on their phone. */
const PROMPT_MS = 180_000;

export const GOOGLE_ACCOUNTS = /^https:\/\/accounts\.google\.com\//;
const PASSKEY = /challenge\/pk/;
const SELECTION = /challenge\/selection/;
const CHALLENGE = /accounts\.google\.com\/.*\/challenge\//;

const EMAIL = { role: "textbox", name: "/email or phone/i" } as const;
const PASSWORD = { role: "textbox", name: "/password/i" } as const;
const NEXT = { role: "button", name: "/^next$/i" } as const;
const CODE_BOX = { role: "textbox", name: "/code/i" } as const;
const PHONE_BOX = { role: "textbox", name: "/^phone number$/i" } as const;
const CONTINUE = { role: "button", name: "/^continue$/i" } as const;
const SWITCH_ACCOUNT = { role: "link", name: "/switch account/i" } as const;
/** "Try another way" on a sign-in, "More ways to verify" on a re-auth. */
const OTHER_WAY = { text: "/try another way|more ways to verify/i" } as const;
const LOCKED = { text: "/too many failed attempts/i" } as const;
/** One Tap's confirm button: `gsi/select` is a card, not a sign-in page. */
const ONE_TAP_CONFIRM = { css: "#confirm_yes" } as const;

/** A step on the selection page: a link on some accounts, a button on others; a greyed one does not count. */
const choice = (text: string): Hints => ({
  css: `:is(a,button,[role=link],[role=button]):not([aria-disabled="true"]):has-text("${text}")`,
});

export function googleWalk(ctx: SignInContext): Walk<SignInContext> {
  const { cred } = ctx;
  const site = "google";
  const fail = (why: string): never => {
    throw new LoginFailed(site, why);
  };
  const mine = { text: cred.username } as const;
  let typedPrevious = false;
  let passwordTyped = false;
  let passkeyTried = false;
  let refused: string | null = null;
  const only = (what: string) => (refused ? `${what}; ${refused}` : what);
  // Wrong codes lock the account's texts for hours: say so, never guess on.
  const lockedOut = () =>
    fail("Google: too many failed attempts on this account; try again in a few hours");

  const submitCode = async (fp: FlowPage, code: string) => {
    await fp.act({ kind: "fill", value: code }, CODE_BOX, { goal: "type the verification code" });
    await fp.act({ kind: "click" }, NEXT, { goal: "submit the code" });
  };
  /** To Google's "Choose how you want to sign in" list. */
  const otherWay = async (fp: FlowPage) => {
    await fp.act({ kind: "click" }, OTHER_WAY, { goal: "see the other second steps" });
    await fp.waitForUrl(SELECTION, 10_000);
  };

  // "Enter a phone number to get a text message with a verification code": a
  // Workspace user with no phone of its own, asked first (Google stores it). Ours.
  const ours = ctx.inbox("sms");
  const canText = ctx.offers("sms") && Boolean(ours && /^\+?\d[\d\s().-]{6,}$/.test(ours));
  const textOurs = async (fp: FlowPage): Promise<Date> => {
    if (await fp.has(LOCKED)) lockedOut();
    const asked = new Date();
    await fp.act({ kind: "fill", value: ours ?? "" }, PHONE_BOX, { goal: "give Google our phone" });
    await fp.act({ kind: "click" }, NEXT, { goal: "send the text" });
    await fp.wait(SETTLE_MS);
    return asked;
  };
  const answerText = async (fp: FlowPage, asked: Date) => {
    if (await fp.has(LOCKED)) lockedOut();
    if (!(await fp.has(CODE_BOX, RENDER_MS))) fail("no code box after asking for the SMS");
    // Every sender texts the same phone: only a code that came after this ask is this account's.
    await submitCode(fp, await ctx.code("sms", "google", asked));
    await fp.wait(SETTLE_MS);
    if (await fp.has(LOCKED)) lockedOut();
    if (await fp.has({ text: "/wrong code/i" })) fail("Google said the texted code was wrong");
  };

  /** The second step from the selection list, by what this system can answer. */
  const secondStep = async (fp: FlowPage): Promise<void> => {
    if (cred.passkeys.length && !passkeyTried && (await fp.has(choice("Use your passkey"))))
      return fp.act({ kind: "click" }, choice("Use your passkey"), {
        goal: "verify with our passkey",
      });
    if (ctx.offers("totp")) {
      const totp = choice("authenticator app");
      if (!(await fp.has(totp, RENDER_MS)))
        fail(only("Google does not offer the authenticator app here"));
      return fp.act({ kind: "click" }, totp, { goal: "choose the authenticator app" });
    }
    // Google lists every phone it knows, masked to the last two digits, and
    // greys out one it was given minutes ago ("for your security"). Only a
    // live link to the phone we can read counts.
    const tail = ours?.slice(-2);
    const smsLink: Hints = { css: `${choice("verification code at").css}:has-text("••${tail}")` };
    // A Workspace user on a new browser gets one choice and no digits: "Get a
    // verification code sent to your phone" (and "Try another way" is a dead end,
    // "Couldn't sign you in"; mapped 2026-09-25). Taken when it is the only phone step.
    const unmasked = choice("verification code sent to your phone");
    const sms =
      ctx.offers("sms") && tail && (await fp.has(smsLink))
        ? smsLink
        : ctx.offers("sms") && (await fp.has(unmasked))
          ? unmasked
          : null;
    if (sms)
      // The ask and the read stay together under the inbox lock: another
      // sign-in on this machine must not take this account's text.
      return serially(ctx, "sms", async () => {
        const asked = new Date();
        await fp.act({ kind: "click" }, sms, { goal: "have Google text the code" });
        await fp.wait(SETTLE_MS);
        if (canText && (await fp.has(PHONE_BOX, RENDER_MS)))
          return answerText(fp, await textOurs(fp));
        return answerText(fp, asked);
      });
    const tapYes = choice("Tap Yes on your phone");
    if (ctx.notify && (await fp.has(tapYes))) {
      const before = fp.url();
      await fp.act({ kind: "click" }, tapYes, { goal: "ask the phone for a Yes" });
      // The page says where the prompt went ("Open the YouTube app on Apple iPhone 12"); pass it on.
      await fp.wait(SETTLE_MS);
      const where = (await fp.text()).match(/open the .{1,60}? app on [^\n.]{1,60}/i)?.[0];
      await ctx.notify(
        `Google sign-in for ${cred.username}: ${where ?? "tap Yes on your phone"} and tap Yes`,
      );
      const moved = await fp.waitForUrl((u) => !CHALLENGE.test(u) && u !== before, PROMPT_MS);
      if (!moved) fail("no Yes from the phone within three minutes");
      return;
    }
    fail(
      only(
        "Google wants a second step and none is set up: enroll TOTP, link a phone, or configure Twilio",
      ),
    );
  };

  const screens: Screen<SignInContext>[] = [
    {
      name: "done",
      looks: "a page off accounts.google.com: the site, or the Google Account page",
      is: async ({ fp }) => /^https?:/.test(fp.url()) && !GOOGLE_ACCOUNTS.test(fp.url()),
      goal: true,
    },
    {
      name: "locked",
      looks: "'Too many failed attempts': the account's texts are locked for hours",
      shows: [LOCKED],
      act: async () => lockedOut(),
    },
    {
      name: "refused browser",
      looks: "'This browser or app may not be secure'",
      at: GOOGLE_ACCOUNTS,
      says: /browser or app may not be secure/i,
      act: async () => fail("Google refused this browser"),
    },
    {
      name: "unknown account",
      looks: "'Couldn't find your Google Account' under the email box",
      at: GOOGLE_ACCOUNTS,
      says: /couldn.t find your google account/i,
      act: async () => fail("unknown account"),
    },
    {
      name: "wrong password",
      looks: "the password box with 'Wrong password. Try again'",
      shows: [PASSWORD],
      says: /wrong password/i,
      async act({ fp }) {
        // A rotation the site took without saying so: the one before still works once.
        if (!cred.previousPassword || typedPrevious) fail("password rejected");
        typedPrevious = true;
        await fp.act({ kind: "fill", value: cred.previousPassword as string }, PASSWORD, {
          goal: "type the previous Google password",
        });
        await fp.act({ kind: "click" }, NEXT, { goal: "submit it" });
      },
    },
    // One Tap (`gsi/select`) picks an account the profile is already signed in
    // as and asks to confirm it: no password. Its channel to the opener dies if
    // the opener navigates, so nothing here touches the main page (mapped
    // 2026-09-22 on LinkedIn). A card with neither is a full sign-in: the
    // screens below.
    {
      name: "one tap confirm",
      looks: "Google One Tap asking to confirm the signed-in account",
      at: /\/gsi\/select/,
      shows: [ONE_TAP_CONFIRM],
      act: ({ fp }) => fp.act({ kind: "click" }, ONE_TAP_CONFIRM, { goal: "confirm the sign-in" }),
    },
    {
      name: "one tap account",
      looks: "Google One Tap listing the account to pick",
      at: /\/gsi\/select/,
      shows: [mine],
      act: ({ fp }) => fp.act({ kind: "click" }, mine, { goal: "pick the account" }),
    },
    {
      name: "someone else",
      looks: "a page for another account, with '<other> selected. Switch account'",
      shows: [SWITCH_ACCOUNT],
      is: async ({ fp }) => !(await fp.text()).toLowerCase().includes(cred.username.toLowerCase()),
      act: ({ fp }) =>
        fp.act({ kind: "click" }, SWITCH_ACCOUNT, { goal: `switch to ${cred.username}` }),
    },
    {
      name: "chooser",
      looks: "'Choose an account': the profile's accounts and 'Use another account'",
      at: GOOGLE_ACCOUNTS,
      says: /choose an account/i,
      async act({ fp }) {
        if (await fp.has(mine))
          return fp.act({ kind: "click" }, mine, { goal: "pick the account" });
        await fp.act(
          { kind: "click" },
          { text: "/use another account/i" },
          { goal: "use another account" },
        );
      },
    },
    {
      // A Workspace user's first sign-in: the terms, and "I understand" (speedbump/gaplustos).
      name: "new account terms",
      looks: "'Welcome to your new account' and the terms, with 'I understand'",
      at: GOOGLE_ACCOUNTS,
      is: async ({ fp }) =>
        /speedbump\/gaplustos/.test(fp.url()) ||
        /welcome to your new account/i.test(await fp.text()),
      act: ({ fp }) =>
        fp.act(
          { kind: "click" },
          { role: "button", name: "/i understand/i" },
          { goal: "accept the new account's terms" },
        ),
    },
    {
      // "Google will allow x.com to access this info about you", "You're
      // signing back in to x": Continue. A site that asks for more than
      // sign-in (Cal.com: the calendar) shows a second page after it, "already
      // has some access", with its own Continue; it grants nothing new. The
      // page renders late ("Loading"), so the button decides, not the text.
      name: "consent",
      looks: "the OAuth consent: what the site gets, and 'Continue'",
      at: /accounts\.google\.com\/signin\/oauth/,
      shows: [CONTINUE],
      act: ({ fp }) => fp.act({ kind: "click" }, CONTINUE, { goal: "consent to the sign-in" }),
    },
    {
      name: "selection",
      looks:
        "'Choose how you want to sign in' / 'Choose a way to verify': the second steps as a list",
      at: SELECTION,
      async act({ fp }) {
        // Before the password, the list offers it (an account with a passkey is asked for that first).
        const password = choice("Enter your password");
        if (!passwordTyped && (await fp.has(password, 3_000))) {
          await fp.act({ kind: "click" }, password, { goal: "sign in with the password instead" });
          await fp.waitForUrl(/challenge\/pwd/, 10_000);
          return;
        }
        await secondStep(fp);
      },
    },
    {
      // Before the password ("Verifying it's you… Complete sign-in using your
      // passkey", mapped 2026-09-19) or after it ("Use your passkey to confirm
      // it's really you", mapped 2026-09-22 on admin.google.com). Google can ask
      // twice: the code, then the passkey again (Langfuse, 2026-09-22).
      name: "passkey",
      looks: "Google asking for the account's passkey",
      is: async ({ fp }) =>
        GOOGLE_ACCOUNTS.test(fp.url()) &&
        (PASSKEY.test(fp.url()) ||
          /using your passkey|use your passkey to confirm/i.test(await fp.text())),
      async act({ fp }) {
        if (cred.passkeys.length && !passkeyTried) {
          passkeyTried = true;
          // A "presend" page first ("Your device will ask for your fingerprint… Continue");
          // then the ceremony, which our authenticator completes on its own.
          if (await fp.has(CONTINUE, 3_000))
            await fp.act({ kind: "click" }, CONTINUE, { goal: "start the passkey ceremony" });
          if (await fp.waitForUrl((u) => !PASSKEY.test(u), 20_000)) return;
          // "Something went wrong… Bluetooth" (pk/error): Google does not hold
          // the passkey we hold; the other steps get their turn, and the error
          // names this when none of them is offered.
          refused = `our passkey was refused (${fp.url().replace(/\?.*/, "")})`;
        }
        await otherWay(fp);
      },
    },
    {
      name: "authenticator code",
      looks: "the box for the authenticator app's code",
      at: /challenge\/totp/,
      shows: [CODE_BOX],
      async act({ fp }) {
        if (!ctx.offers("totp")) return otherWay(fp);
        await submitCode(fp, await ctx.code("totp"));
      },
    },
    {
      name: "phone box",
      looks: "'Enter a phone number to get a text message with a verification code'",
      shows: [PHONE_BOX],
      async act({ fp }) {
        if (!canText) return otherWay(fp);
        await serially(ctx, "sms", async () => answerText(fp, await textOurs(fp)));
      },
    },
    {
      name: "password",
      looks: "'Hi <name>' and the password box",
      shows: [PASSWORD],
      async act({ fp }) {
        await fp.act({ kind: "fill", value: passwordOf(site, cred) }, PASSWORD, {
          goal: "type the Google password",
        });
        passwordTyped = true;
        await fp.act({ kind: "click" }, NEXT, { goal: "submit the password" });
      },
    },
    {
      name: "email",
      looks: "'Sign in' with the 'Email or phone' box",
      shows: [EMAIL],
      async act({ fp }) {
        await fp.act({ kind: "fill", value: cred.username }, EMAIL, {
          goal: "type the Google email",
        });
        await fp.act({ kind: "click" }, NEXT, { goal: "continue past the email" });
      },
    },
    {
      // Any other second step ("Verify it's you", a code box for a step we
      // did not ask for, "Confirm your recovery email"): to the list when the
      // page offers it, else nothing here can answer.
      name: "other challenge",
      looks:
        "a second step this system did not choose: a code box, 'Verify it's you', a recovery question",
      is: async ({ fp }) =>
        GOOGLE_ACCOUNTS.test(fp.url()) &&
        (CHALLENGE.test(fp.url()) ||
          /2-step verification|verification code|enter the code|verify it.s you|confirm your recovery|tap yes on your/i.test(
            await fp.text(),
          )),
      async act({ fp }) {
        if (!(await fp.has(OTHER_WAY)))
          fail("Google asked for a second step this tool cannot answer");
        await otherWay(fp);
      },
    },
  ];
  return {
    site,
    name: "sign-in",
    goal: "signed in to Google and back on the site that asked",
    // Chooser, email, password, passkey, list, code, passkey again, list, code, two consents.
    maxSteps: 16,
    fail,
    screens,
  };
}

/**
 * Google's own sign-in pages, wherever they appear: the admin console, or
 * the popup behind another site's "Google" button. Done when the page is
 * off accounts.google.com (a popup that closed itself counts).
 */
export async function signInToGoogle(ctx: SignInContext): Promise<void> {
  await walk(ctx, googleWalk(ctx));
}

registerProvider({
  site: "google",
  host: /accounts\.google\.com/,
  buttons: [
    { role: "button", name: "/google/i" },
    { role: "link", name: "/google/i" },
    { text: "/(continue|sign ?in|log ?in|sign ?up) with google/i" },
    // Google Identity Services renders the button itself, cross-origin, so the
    // page's own locators never see it (LinkedIn, mapped 2026-09-22).
    { frame: 'iframe[src*="accounts.google.com/gsi/button"]', css: "div[role=button]" },
  ],
  signIn: signInToGoogle,
});
