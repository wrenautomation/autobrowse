/**
 * LEARN (learn.uwaterloo.ca, D2L Brightspace) behind the University of
 * Waterloo's sign-in: the `outlook@uw` credential (the WatIAM account).
 * Mapped 2026-10-23 in explore: LEARN sends a signed-out browser straight
 * to adfs.uwaterloo.ca (SAML), which asks "User Account" → Next →
 * "Password" → "Sign in", then Duo's Universal Prompt
 * (api-*.duosecurity.com): "Send a passcode" texts the phone ("SMS
 * passcodes (will expire in N days): 1234567"), "Passcode" → "Verify",
 * then "Yes, this is my device" keeps the browser trusted for a while.
 */
import { type Screen, walk } from "../browser/screens.js";
import { LoginFailed, passwordOf, type SignInContext, type SiteLogin, serially } from "./login.js";

export const LEARN = "https://learn.uwaterloo.ca";
const ADFS = /adfs\.uwaterloo\.ca\/adfs\//;
export const DUO = /\.duosecurity\.com\//;
/** Past the sign-in: any LEARN page but its own login page. */
const SIGNED_IN = /^https:\/\/learn\.uwaterloo\.ca\/d2l\/(?!login)/;

const USER = { role: "textbox", name: "User Account" } as const;
const PASSWORD = { role: "textbox", name: "Password" } as const;
const SEND = { role: "button", name: "/^send a passcode/i" } as const;
const PASSCODE = { role: "textbox", name: "Passcode" } as const;
const OTHER_OPTIONS = { text: "/^other options$/i" } as const;
const TRUST = { role: "button", name: "/^yes, this is my device$/i" } as const;

export async function signInToLearn(ctx: SignInContext): Promise<void> {
  const site = "learn";
  const fail = (why: string): never => {
    throw new LoginFailed(site, why);
  };
  const click = (hints: Parameters<SignInContext["fp"]["act"]>[1], goal: string) =>
    ctx.fp.act({ kind: "click" }, hints, { goal });
  const screens: Screen<SignInContext>[] = [
    {
      name: "signed in",
      looks: "a LEARN page past the sign-in",
      is: async ({ fp }) => SIGNED_IN.test(fp.url()),
      goal: true,
    },
    {
      name: "rejected",
      looks: "the university's sign-in saying the account or password is wrong",
      at: ADFS,
      says: /incorrect user id or password|incorrect user name or password/i,
      act: async () => fail("password rejected"),
    },
    {
      name: "password",
      looks: "the university's sign-in asking for the password",
      at: ADFS,
      shows: [PASSWORD],
      async act({ fp, cred }) {
        await fp.act({ kind: "fill", value: passwordOf(site, cred) }, PASSWORD, {
          goal: "type the password",
        });
        await click({ role: "button", name: "Sign in" }, "submit the password");
      },
    },
    {
      name: "user",
      looks: "the university's sign-in asking for the user account",
      at: ADFS,
      shows: [USER],
      hides: [PASSWORD],
      async act({ fp, cred }) {
        await fp.act({ kind: "fill", value: cred.username }, USER, { goal: "type the account" });
        await click({ role: "button", name: "Next" }, "continue past the account");
      },
    },
    {
      name: "trust device",
      looks: "Duo asking 'Is this your device?'",
      at: DUO,
      shows: [TRUST],
      act: () => click(TRUST, "trust this browser"),
    },
    {
      name: "wrong passcode",
      looks: "Duo saying the passcode is wrong",
      at: DUO,
      says: /incorrect passcode|invalid passcode/i,
      act: async () => fail("Duo refused the texted passcode"),
    },
    {
      name: "methods",
      looks: "Duo's list of ways to verify, with 'Send a passcode'",
      at: DUO,
      shows: [SEND],
      async act(c) {
        if (!c.offers("sms")) fail("Duo wants a texted passcode; no phone is linked");
        // One sign-in at a time asks the phone: a texted code names no account.
        await serially(c, "sms", async () => {
          const asked = new Date();
          await click(SEND, "have Duo text a passcode");
          const code = await c.code("sms", "passcode", asked);
          await c.fp.act({ kind: "fill", value: code }, PASSCODE, { goal: "type the passcode" });
          await click({ role: "button", name: "Verify" }, "submit the passcode");
        });
      },
    },
    {
      name: "push",
      looks: "Duo waiting on a push to the phone, with 'Other options'",
      at: DUO,
      // The passcode page has "Other options" too: only the push page names the push.
      says: /duo push/i,
      shows: [OTHER_OPTIONS],
      hides: [SEND, PASSCODE, TRUST],
      act: () => click(OTHER_OPTIONS, "choose another way to verify"),
    },
  ];
  await ctx.fp.open(`${LEARN}/d2l/home`, { allowWall: true });
  await walk(ctx, { site, name: "sign-in", goal: "signed in to LEARN", fail, screens });
}

export const learnLogin: SiteLogin = {
  site: "learn",
  home: `${LEARN}/d2l/home`,
  credential: "outlook@uw",
  ask: "Your University of Waterloo account (WatIAM), for LEARN",
  // adfs.uwaterloo.ca shares the home's registrable name; the password is never typed on Duo.
  loggedIn: async (fp) => SIGNED_IN.test(fp.url()),
  signIn: signInToLearn,
  signInHere: { at: ADFS, run: signInToLearn },
};
