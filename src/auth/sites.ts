/**
 * Login pages we know. Locators are visible labels, so a redesign fails
 * loudly and the repairer gets a chance. Every one is UNVERIFIED against
 * the live page until its first run; the memory layer keeps what worked.
 * Verified: cloudflare via Google (2026-09-19). Public login forms read
 * live on 2026-09-21 (headless explore): github, microsoft (first page), linkedin.
 */

import { backFrom, clickOpening, type Walk, walk } from "../browser/screens.js";
import { FACEBOOK_LOGIN_URL, signInToFacebook } from "./facebook.js";
import { signInToGithub } from "./github.js";
import { signInToGoogle } from "./google.js";
import { INSTAGRAM_LOGIN_URL, signInToInstagram } from "./instagram.js";
import { LINKEDIN_LOGIN_URL, signInToLinkedin } from "./linkedin.js";
import {
  addressOf,
  formLogin,
  LoginFailed,
  oauthLogin,
  type PasskeySetupSpec,
  type PasswordChangeSpec,
  passwordOf,
  type SignInContext,
  type SiteLogin,
  serially,
  type TotpSetupSpec,
} from "./login.js";
import { MICROSOFT_HOST, signInToMicrosoft } from "./microsoft.js";
import { providerOf } from "./providers.js";
import { signInToTiktok, TIKTOK_LOGIN_URL } from "./tiktok.js";
import { signInToX, X_LOGIN_URL } from "./x.js";

const CLOUDFLARE_HOME = /dash\.cloudflare\.com\/[0-9a-f]{32}/;
const CLOUDFLARE_LOGIN = "https://dash.cloudflare.com/login";
const GOOGLE_ACCOUNTS = /^https:\/\/accounts\.google\.com\//;

/** A returning browser's saved profile: "Continue as <email> using Google". Seen 2026-09-28. */
const SAVED_PROFILE = { role: "button", name: "/^continue as .+ using google$/i" } as const;
const OTHER_PROFILE = { role: "button", name: "Sign in with another profile" } as const;
const EMAIL = { role: "textbox", name: "Email" } as const;
const PASSWORD = { role: "textbox", name: "Password" } as const;
const LOG_IN = { role: "button", name: "/^(log|sign) ?in$/i" } as const;
const CODE = { role: "textbox", name: "/code/i" } as const;

/**
 * Whether a saved profile's label names this address. Cloudflare cuts a
 * long one short ("jinwi…@gmail.com", "jinwi…"): the shown parts, in order.
 */
export function savedProfileIs(label: string, address: string): boolean {
  const shown = label
    .match(/continue as (.+?) using google/i)?.[1]
    ?.trim()
    .toLowerCase();
  if (!shown || !address) return false;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cut = /(…|\.\.\.)$/.test(shown);
  const parts = shown.split(/…|\.\.\./).map(esc);
  return new RegExp(`^${parts.join(".*")}${cut ? "" : "$"}`).test(address.trim().toLowerCase());
}

/**
 * Cloudflare's sign-in as screens: whichever way the page comes (the form,
 * a saved profile, Google in a popup or a redirect, a code), the walk
 * does the right thing there and looks again.
 *
 * - A saved profile for this account rides the browser's live Google
 *   session: no secret typed. If Google then wants a password the session
 *   is gone, and the walk stops rather than type one (the account is
 *   personal; a rejected personal password is never retried).
 * - A saved profile for someone else: "Sign in with another profile".
 * - The form: the password, or the Google button when the account signs
 *   in via Google (the credential's `via`, or no password).
 */
export function cloudflareWalk(ctx: SignInContext): Walk<SignInContext> {
  const { cred } = ctx;
  const main = ctx.fp.page;
  const byGoogle = cred.via === "google" || !cred.password;
  const ours = (label: string) =>
    savedProfileIs(label, addressOf(cred)) || savedProfileIs(label, cred.username);
  let riding = false;
  let typedPrevious = false;
  const fail = (why: string): never => {
    throw new LoginFailed("cloudflare", why);
  };
  return {
    site: "cloudflare",
    name: "sign-in",
    goal: "signed in to the Cloudflare dashboard",
    fail,
    screens: [
      {
        name: "dashboard",
        looks: "the Cloudflare dashboard, signed in",
        at: CLOUDFLARE_HOME,
        hides: [PASSWORD],
        goal: true,
      },
      {
        name: "google",
        looks: "Google's own sign-in: account chooser, email, password or 2-step",
        at: GOOGLE_ACCOUNTS,
        async act(c) {
          const { fp } = c;
          if (riding) {
            // A tile for an account the profile is signed in as needs no password.
            const tile = { text: addressOf(cred) } as const;
            if (await fp.has(tile, 3_000))
              await fp.act({ kind: "click" }, tile, { goal: "pick the account" });
            else if (await fp.has({ role: "textbox", name: "/password/i" }))
              fail(
                "the saved Google session is gone and Google wants a password: sign in to Google once in the cloudflare profile",
              );
          } else {
            const google = await c.credFor(
              "google",
              cred.via === "google" ? cred.username : undefined,
            );
            await providerOf("google").signIn(c.as(google));
          }
          await backFrom(fp, main);
          await fp.waitForUrl(CLOUDFLARE_HOME, 30_000);
        },
      },
      {
        name: "saved profile",
        looks: "'Continue as <email> using Google', with 'Sign in with another profile'",
        shows: [SAVED_PROFILE],
        async act({ fp }) {
          if (ours(await fp.read(SAVED_PROFILE))) {
            riding = true;
            return clickOpening(fp, SAVED_PROFILE, "continue with the saved Google profile");
          }
          await fp.act({ kind: "click" }, OTHER_PROFILE, { goal: "sign in with another profile" });
        },
      },
      {
        name: "rejected",
        looks: "the login form saying the email or password is wrong",
        shows: [PASSWORD],
        says: /incorrect email or password|invalid credentials/i,
        async act({ fp }) {
          // A rotation the site took without saying so: the one before still works once.
          if (!cred.previousPassword || typedPrevious) fail("password rejected");
          typedPrevious = true;
          await fp.act({ kind: "fill", value: cred.previousPassword as string }, PASSWORD, {
            goal: "type the previous password",
          });
          await fp.act({ kind: "click" }, LOG_IN, { goal: "submit login form" });
        },
      },
      {
        name: "code",
        looks: "a box asking for an authenticator or two-factor code",
        shows: [CODE],
        says: /authenticator|verification code|two-factor|2fa/i,
        async act(c) {
          const code = await c.code("totp");
          await c.fp.act({ kind: "fill", value: code }, CODE, { goal: "type verification code" });
          await c.fp.act(
            { kind: "click" },
            { role: "button", name: "/continue|verify/i" },
            {
              goal: "submit verification code",
            },
          );
        },
      },
      {
        name: "login form",
        looks: "the Cloudflare login form: email and password boxes, and 'Sign in with Google'",
        shows: [EMAIL],
        async act({ fp }) {
          if (byGoogle)
            return clickOpening(fp, { role: "button", name: "/google/i" }, "sign in with google");
          await fp.act({ kind: "fill", value: cred.username }, EMAIL, { goal: "type username" });
          await fp.act({ kind: "fill", value: passwordOf("cloudflare", cred) }, PASSWORD, {
            goal: "type password",
          });
          await fp.act({ kind: "click" }, LOG_IN, { goal: "submit login form" });
        },
      },
    ],
  };
}

/**
 * Cloudflare: the stored `cloudflare` credential, by password or through
 * Google (`via: "google"`, or no password). One account can hold both;
 * the password goes first (`methodsOf`).
 */
const cloudflare: SiteLogin = {
  site: "cloudflare",
  home: "https://dash.cloudflare.com/",
  ask: "Your Cloudflare account (dash.cloudflare.com), where the domains get registered",
  via: ["google"],
  // A signed-in dashboard URL carries the 32-hex account id; the bare host is the pre-redirect state.
  loggedIn: async (fp) =>
    CLOUDFLARE_HOME.test(fp.url()) && !(await fp.has({ role: "textbox", name: "Password" })),
  async signIn(ctx: SignInContext) {
    await ctx.fp.open(CLOUDFLARE_LOGIN, { allowWall: true });
    await walk(ctx, cloudflareWalk(ctx));
  },
};

/** Where any Google account turns on an authenticator app. Mapped 2026-09-19 in explore mode. */
const GOOGLE_TOTP_SETUP: TotpSetupSpec = {
  // authuser= names the account: a profile with two Google accounts would otherwise get the first.
  url: (cred) =>
    `https://myaccount.google.com/two-step-verification/authenticator?authuser=${encodeURIComponent(cred.username)}`,
  reveal: [
    { role: "button", name: "Set up authenticator" },
    { role: "button", name: "/can.t scan it/i" },
  ],
  toCode: [{ role: "button", name: "Next" }],
  code: { role: "textbox", name: "/enter code/i" },
  confirm: { role: "button", name: "Verify" },
  done: /authenticator app added|authenticator app.*(on|set up)|turned on/i,
};

/** Mapped 2026-09-19: re-auth happens on the way in (signInHere), then two boxes and a button. */
const GOOGLE_PASSWORD_CHANGE: PasswordChangeSpec = {
  url: (cred) =>
    `https://myaccount.google.com/signinoptions/password?authuser=${encodeURIComponent(cred.username)}`,
  next: { role: "textbox", name: "New password" },
  confirm: { role: "textbox", name: "Confirm new password" },
  submit: { role: "button", name: "Change password" },
  done: /password changed|password was changed|your password has been changed|sign in with your new password|security checkup|myaccount\.google\.com\/(security|signinoptions\/password\?)/i,
};

/** Mapped 2026-09-19: "Create a passkey" runs the WebAuthn ceremony; the virtual authenticator answers it. */
const GOOGLE_PASSKEY_SETUP: PasskeySetupSpec = {
  url: (cred) =>
    `https://myaccount.google.com/signinoptions/passkeys?authuser=${encodeURIComponent(cred.username)}`,
  create: { role: "button", name: "/create a passkey|create passkey/i" },
  confirmations: [{ role: "button", name: "/^continue passkey enrollment$/i" }],
  done: /passkey created|you can now use your passkey|passkeys? you created|created (a )?passkey/i,
};

/** Google re-asks for the password on security pages; answer on the spot. */
const GOOGLE_SIGN_IN_HERE = { at: /^https:\/\/accounts\.google\.com\//, run: signInToGoogle };

/** A Google Account page, not its signed-out `/intro/` twin. */
const GOOGLE_SIGNED_IN = /^https:\/\/myaccount\.google\.com\/(?!intro(\/|\?|$))/;

/** The personal Google account: what "Sign in with Google" buttons use. */
const google: SiteLogin = {
  site: "google",
  home: "https://myaccount.google.com/",
  origins: ["google.com"],
  ask: 'Your Google account: the one behind every "Sign in with Google" button',
  loggedIn: async (fp) => GOOGLE_SIGNED_IN.test(fp.url()),
  async signIn(ctx) {
    await ctx.fp.open(
      "https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/",
      { allowWall: true },
    );
    await signInToGoogle(ctx);
    if (!(await ctx.fp.waitForUrl(GOOGLE_SIGNED_IN, 30_000)))
      throw new LoginFailed("google", `still on ${ctx.fp.url()} after Google sign-in`);
  },
  signInHere: GOOGLE_SIGN_IN_HERE,
  totpSetup: GOOGLE_TOTP_SETUP,
  passwordChange: GOOGLE_PASSWORD_CHANGE,
  passkeySetup: GOOGLE_PASSKEY_SETUP,
};

/**
 * The Workspace admin console: its own credential, a Workspace admin of
 * the domains (a personal Gmail signs in fine and then gets "Sign in with
 * an administrator account").
 */
/**
 * A Google app (Gmail, Drive, …) is not a login of its own: it signs in
 * with the Google account, `google` (or `google@<label>` for `gmail@<label>`).
 * Signed in = the app's own page loads without a detour to accounts.google.com.
 */
function googleApp(site: string, home: string, signedIn: RegExp): SiteLogin {
  return {
    ...google,
    site,
    home,
    credential: "google",
    ask: `Your Google account: ${site} signs in with it`,
    loggedIn: async (fp) => signedIn.test(fp.url()),
    async signIn(ctx) {
      await google.signIn(ctx);
      await ctx.fp.open(home, { allowWall: true });
      if (!(await ctx.fp.waitForUrl(signedIn, 30_000)))
        throw new LoginFailed(site, `still on ${ctx.fp.url()} after Google sign-in`);
    },
  };
}

const GOOGLE_APPS: readonly SiteLogin[] = [
  googleApp("gmail", "https://mail.google.com/mail/u/0/", /^https:\/\/mail\.google\.com\/mail\//),
  googleApp(
    "drive",
    "https://drive.google.com/drive/my-drive",
    /^https:\/\/drive\.google\.com\/drive\//,
  ),
  googleApp(
    "calendar",
    "https://calendar.google.com/calendar/r",
    /^https:\/\/calendar\.google\.com\/calendar\//,
  ),
  googleApp(
    "docs",
    "https://docs.google.com/document/u/0/",
    /^https:\/\/docs\.google\.com\/document\//,
  ),
  googleApp(
    "sheets",
    "https://docs.google.com/spreadsheets/u/0/",
    /^https:\/\/docs\.google\.com\/spreadsheets\//,
  ),
];

const googleAdmin: SiteLogin = {
  site: "google-admin",
  home: "https://admin.google.com/",
  ask: "A Google Workspace admin (admin.google.com) for the mail domains; a personal Gmail is refused there",
  loggedIn: async (fp) =>
    /admin\.google\.com/.test(fp.url()) &&
    !/accounts\.google\.com/.test(fp.url()) &&
    !(await fp.has({ text: "/administrator account/i" })),
  async signIn(ctx) {
    await ctx.fp.open(
      "https://accounts.google.com/ServiceLogin?continue=https://admin.google.com/",
      { allowWall: true },
    );
    await signInToGoogle(ctx);
    if (!(await ctx.fp.waitForUrl(/admin\.google\.com/, 30_000)))
      throw new LoginFailed("google-admin", `still on ${ctx.fp.url()} after Google sign-in`);
    await ctx.fp.wait(1_500);
    if (await ctx.fp.has({ text: "/administrator account/i" }))
      throw new LoginFailed(
        "google-admin",
        `${ctx.cred.username} is not a Workspace admin; store the admin account as credential "google-admin"`,
      );
  },
  signInHere: GOOGLE_SIGN_IN_HERE,
  totpSetup: GOOGLE_TOTP_SETUP,
  passwordChange: GOOGLE_PASSWORD_CHANGE,
  passkeySetup: GOOGLE_PASSKEY_SETUP,
};

const instantly: SiteLogin = {
  site: "instantly",
  home: "https://app.instantly.ai/",
  ask: "Your Instantly login (app.instantly.ai), for warmup",
  loggedIn: async (fp) => /app\.instantly\.ai\/app/.test(fp.url()),
  signIn: formLogin("instantly", {
    start: "https://app.instantly.ai/auth/login",
    username: { role: "textbox", name: "Email" },
    password: { role: "textbox", name: "Password" },
    submit: { role: "button", name: "/^(log|sign) ?in$/i" },
    code: {
      kind: "email",
      asks: /verification code|check your email/i,
      field: { role: "textbox", name: "/code/i" },
      submit: { role: "button", name: "/verify/i" },
      hint: "instantly",
    },
    rejected: /invalid email or password/i,
    success: /app\.instantly\.ai\/app/,
  }),
};

/**
 * AWS console sign-in, the page behind `aws login` and `aws sso`: an IAM user
 * (`username` = `<account id or alias>/<iam user>`) or the root user
 * (`username` = the account email). Both take a TOTP from the stored seed.
 * Unverified until its first run.
 */
export function awsIdentity(
  username: string,
): { kind: "root" } | { kind: "iam"; account: string; user: string } {
  if (username.includes("@")) return { kind: "root" };
  const [account, user] = username.split("/", 2);
  if (!account || !user) {
    throw new LoginFailed(
      "aws",
      "username must be <account id or alias>/<iam user>, or the root email",
    );
  }
  return { kind: "iam", account, user };
}

const AWS_SIGNED_IN =
  /console\.aws\.amazon\.com|signin\.aws\.amazon\.com\/v1\/sessions\/confirmation|allow access/i;

const aws: SiteLogin = {
  site: "aws",
  home: "https://console.aws.amazon.com/",
  ask: "Your AWS console sign-in (root email, or <account>/<iam user>), for `aws login`",
  loggedIn: async (fp) =>
    /console\.aws\.amazon\.com/.test(fp.url()) &&
    !/signin\.aws\.amazon\.com/.test(fp.url()) &&
    !(await fp.has({ role: "textbox", name: "Password" })),
  async signIn({ fp, cred, code }: SignInContext) {
    const who = awsIdentity(cred.username);
    // The sign-in page renders its form 10–40 s after DOMContentLoaded (headless is slow-walked).
    const password = { role: "textbox", name: "Password" } as const;
    if (!(await fp.has(password, 45_000))) {
      // The bare /signin URL answers 400 since the 2026 sign-in update; the console bounces to the live one.
      await fp.open("https://console.aws.amazon.com/", { allowWall: true });
      await fp.has(password, 45_000);
    }
    if (who.kind === "root") {
      const rootButton = { role: "button", name: "/root user email/i" } as const;
      if (await fp.has(rootButton))
        await fp.act({ kind: "click" }, rootButton, { goal: "root user sign-in" });
      await fp.act(
        { kind: "fill", value: cred.username },
        { role: "textbox", name: "/root user email/i" },
        { goal: "type the root email" },
      );
      await fp.act(
        { kind: "click" },
        { role: "button", name: "Next" },
        { goal: "continue past email" },
      );
    } else {
      await fp.act(
        { kind: "fill", value: who.account },
        { role: "textbox", name: "/account id or alias/i" },
        { goal: "type the account" },
      );
      await fp.act(
        { kind: "fill", value: who.user },
        { role: "textbox", name: "/iam username/i" },
        { goal: "type the IAM username" },
      );
    }
    await fp.act(
      { kind: "fill", value: passwordOf("aws", cred) },
      { role: "textbox", name: "Password" },
      { goal: "type password" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/^sign in$/i" },
      { goal: "submit login form" },
    );
    await fp.wait(1_500);
    const text = await fp.text();
    if (/incorrect|authentication failed|invalid/i.test(text))
      throw new LoginFailed("aws", "password rejected");
    const mfa = { role: "textbox", name: "/mfa code|authentication code/i" } as const;
    if (await fp.has(mfa, 8_000)) {
      await fp.act({ kind: "fill", value: await code("totp") }, mfa, { goal: "type the MFA code" });
      await fp.act(
        { kind: "click" },
        { role: "button", name: "/submit|sign in/i" },
        { goal: "submit MFA" },
      );
      await fp.wait(1_500);
    }
    // `aws login` ends on a confirmation page: allow the CLI, which shows the code the terminal asks for.
    const allow = { role: "button", name: "/^allow/i" } as const;
    if (await fp.has(allow, 8_000))
      await fp.act({ kind: "click" }, allow, { goal: "allow the CLI session" });
    if (!AWS_SIGNED_IN.test(fp.url()) && !AWS_SIGNED_IN.test(await fp.text())) {
      throw new LoginFailed("aws", `still on ${fp.url()} after sign-in`);
    }
  },
};

/**
 * Claude Console (platform.claude.com): the account was made with
 * "Continue with Google", so the stored `google` credential signs in through
 * that button (a popup). Mapped 2026-09-21 in explore mode.
 */
const ANTHROPIC_HOME = /platform\.claude\.com\/(?!login)/;
const anthropic: SiteLogin = {
  site: "anthropic",
  home: "https://platform.claude.com/dashboard",
  ask: "Your Claude Console account (platform.claude.com), where API keys are minted",
  via: ["google"],
  // The login form renders under the requested URL (/settings/billing stays), so the URL alone lies.
  loggedIn: async (fp) =>
    ANTHROPIC_HOME.test(fp.url()) &&
    !(await fp.has({ role: "button", name: "/continue with google/i" }, 1_500)),
  signIn: oauthLogin("anthropic", {
    start: "https://platform.claude.com/login",
    button: { role: "button", name: "/google/i" },
    success: ANTHROPIC_HOME,
  }),
};

/**
 * Twilio Console: the account was made with "Sign up with Google" (no
 * password exists); the same button on the sign-up page signs an existing
 * Google-linked account in. Mapped 2026-09-21.
 */
const TWILIO_HOME = /console\.twilio\.com\/account\//;
const twilio: SiteLogin = {
  site: "twilio",
  home: "https://console.twilio.com/",
  ask: "Your Twilio account (console.twilio.com), for the rented number",
  via: ["google"],
  loggedIn: async (fp) => TWILIO_HOME.test(fp.url()),
  signIn: oauthLogin("twilio", {
    start: "https://www.twilio.com/try-twilio",
    button: { role: "button", name: "/google/i" },
    success: TWILIO_HOME,
    // Twilio texts a code after the Google round trip (mapped 2026-09-21);
    // "remember this browser" keeps the profile clear of it for a while.
    challenge: {
      at: /login\.twilio\.com\/u\/mfa-sms-challenge/,
      async run(ctx) {
        const { fp } = ctx;
        // One sign-in at a time asks the phone: a texted code names no account.
        await serially(ctx, "sms", async () => {
          // A code sent for an earlier attempt is older than this sign-in: ask for a fresh one.
          const asked = new Date();
          await fp.act(
            { kind: "click" },
            { role: "button", name: "/^resend$/i" },
            { goal: "have Twilio text a fresh code" },
          );
          const code = await ctx.code("sms", "twilio", asked);
          await fp.act(
            { kind: "click" },
            { id: "rememberBrowser" },
            { goal: "remember this browser" },
          );
          await fp.act(
            { kind: "fill", value: code },
            { id: "code" },
            { goal: "enter the SMS code" },
          );
          await fp.act(
            { kind: "click" },
            { role: "button", name: "/^continue$/i" },
            { goal: "submit the code" },
          );
        });
      },
    },
  }),
};

/**
 * Sentry: the org was made 2026-09-21 with "Register with Google" (no
 * password); the login page's "Sign in with Google" link signs it in. Signed-in pages
 * live on the org's subdomain, the login page on the bare host.
 */
const SENTRY_HOME = /https:\/\/[a-z0-9-]+\.sentry\.io\//;
const sentry: SiteLogin = {
  site: "sentry",
  home: "https://wren-automation.sentry.io/issues/",
  ask: "Your Sentry account (sentry.io), where the DSN lives",
  via: ["google"],
  loggedIn: async (fp) => SENTRY_HOME.test(fp.url()),
  signIn: oauthLogin("sentry", {
    start: "https://sentry.io/auth/login/",
    button: { role: "link", name: "Sign in with Google" },
    success: SENTRY_HOME,
  }),
};

/**
 * LinkedIn: the member's own login (`creds paste linkedin`: email, password,
 * optional authenticator key). `signInHere` covers the login page an OAuth
 * authorize URL shows a signed-out profile, keeping its session_redirect.
 * Unverified until a LinkedIn credential exists.
 */
const LINKEDIN_FEED = "https://www.linkedin.com/feed/";
const linkedin: SiteLogin = {
  site: "linkedin",
  home: LINKEDIN_FEED,
  ask: "Your LinkedIn login (email, password, authenticator key if set)",
  loggedIn: async (fp) => /linkedin\.com\/feed/.test(fp.url()),
  signIn: async (ctx) => {
    await ctx.fp.open("https://www.linkedin.com/login", { allowWall: true });
    await signInToLinkedin(ctx);
    if (!(await ctx.fp.waitForUrl(/linkedin\.com\/feed/, 30_000)))
      throw new LoginFailed("linkedin", `still on ${ctx.fp.url()} after LinkedIn sign-in`);
  },
  signInHere: { at: LINKEDIN_LOGIN_URL, run: signInToLinkedin },
};

const GITHUB_LOGIN = /github\.com\/(login|session)/;
const githubGoogle = oauthLogin("github", {
  start: "https://github.com/login",
  button: { text: "/continue with google/i" },
  success: async (fp) => /github\.com/.test(fp.url()) && !GITHUB_LOGIN.test(fp.url()),
});

/**
 * GitHub: its own password (then the authenticator or emailed device code),
 * or "Continue with Google". One account may hold both: the password goes
 * first (`methodsOf`). GitHub turns away the Google route from a fresh
 * profile, so the password is what runs in the background.
 */
const github: SiteLogin = {
  site: "github",
  // The public home page is no wall; settings is, so opening it starts the sign-in.
  home: "https://github.com/settings/profile",
  ask: "Your GitHub login (username, password, authenticator key if set)",
  via: ["google"],
  loggedIn: async (fp) =>
    /github\.com/.test(fp.url()) &&
    !GITHUB_LOGIN.test(fp.url()) &&
    !(await fp.has({ role: "link", name: "/^sign in$/i" })),
  signIn: async (ctx) => {
    if (ctx.cred.via === "google") return githubGoogle(ctx);
    await ctx.fp.open("https://github.com/login", { allowWall: true });
    await signInToGithub(ctx);
  },
  signInHere: {
    at: GITHUB_LOGIN,
    run: (ctx) => (ctx.cred.via === "google" ? githubGoogle(ctx) : signInToGithub(ctx)),
  },
};

/** Instagram: the professional account's own login. Unverified until a credential exists. */
const instagram: SiteLogin = {
  site: "instagram",
  home: "https://www.instagram.com/",
  ask: "Your Instagram login (username, password, authenticator key if set)",
  loggedIn: async (fp) => !INSTAGRAM_LOGIN_URL.test(fp.url()),
  signIn: async (ctx) => {
    await ctx.fp.open("https://www.instagram.com/accounts/login/", { allowWall: true });
    await signInToInstagram(ctx);
  },
  signInHere: { at: INSTAGRAM_LOGIN_URL, run: signInToInstagram },
};

/** Facebook: the person's account behind the Meta app (Pages, ad accounts). Unverified until a credential exists. */
const facebook: SiteLogin = {
  site: "facebook",
  home: "https://www.facebook.com/",
  origins: ["facebook.com", "meta.com", "fb.com"],
  ask: "Your Facebook login (email, password, authenticator key if set)",
  loggedIn: async (fp) => !FACEBOOK_LOGIN_URL.test(fp.url()),
  signIn: async (ctx) => {
    await ctx.fp.open("https://www.facebook.com/login/", { allowWall: true });
    await signInToFacebook(ctx);
  },
  signInHere: { at: FACEBOOK_LOGIN_URL, run: signInToFacebook },
};

/** X: the account's own login (username/email, password, then a code). Unverified until a credential exists. */
const x: SiteLogin = {
  site: "x",
  home: "https://x.com/home",
  origins: ["x.com", "twitter.com"],
  ask: "Your X login (username or email, password, authenticator key if set)",
  loggedIn: async (fp) => !X_LOGIN_URL.test(fp.url()),
  signIn: async (ctx) => {
    await ctx.fp.open("https://x.com/i/flow/login", { allowWall: true });
    await signInToX(ctx);
  },
  signInHere: { at: X_LOGIN_URL, run: signInToX },
};

/** TikTok: the account's own login (email or username). Unverified until a credential exists. */
const tiktok: SiteLogin = {
  site: "tiktok",
  home: "https://www.tiktok.com/foryou",
  ask: "Your TikTok login (email or username, password)",
  loggedIn: async (fp) =>
    !TIKTOK_LOGIN_URL.test(fp.url()) && !(await fp.has({ role: "button", name: "/^log in$/i" })),
  signIn: async (ctx) => {
    await ctx.fp.open("https://www.tiktok.com/login/phone-or-email/email", { allowWall: true });
    await signInToTiktok(ctx);
  },
  signInHere: { at: TIKTOK_LOGIN_URL, run: signInToTiktok },
};

/**
 * Outlook on the web: the `microsoft` credential signs in (personal at
 * outlook.live.com, work at outlook.office.com; the sign-in host is the
 * same). Unverified until a credential exists.
 */
const OUTLOOK_HOME = /outlook\.(live|office)\.com\/mail/;
const outlook: SiteLogin = {
  site: "outlook",
  home: "https://outlook.live.com/mail/0/",
  credential: "microsoft",
  origins: ["live.com", "microsoftonline.com", "microsoft.com"],
  ask: "The Microsoft account whose mailbox Outlook shows (personal or work)",
  loggedIn: async (fp) => OUTLOOK_HOME.test(fp.url()) && !MICROSOFT_HOST.test(fp.url()),
  signIn: async (ctx) => {
    await ctx.fp.open("https://outlook.live.com/mail/0/", { allowWall: true });
    if (MICROSOFT_HOST.test(ctx.fp.url())) await signInToMicrosoft(ctx);
    if (!(await ctx.fp.waitForUrl(OUTLOOK_HOME, 30_000)))
      throw new LoginFailed("outlook", `still on ${ctx.fp.url()} after the Microsoft sign-in`);
  },
  signInHere: { at: MICROSOFT_HOST, run: signInToMicrosoft },
};

/**
 * npm. The sign-in page is plain and loads headless (mapped 2026-09-22:
 * textbox "Username", textbox "Password", button "Sign In"). The username,
 * not the address, is what npm knows the account by, so `signup --by-hand
 * --handle` stores the handle as the credential's username and keeps the
 * address as `codesInbox`. Signed in, npmjs.com shows
 * the account menu instead of the Sign In link.
 *
 * Second step, mapped 2026-09-22: with no 2FA, npm emails a one-time
 * password on every sign-in (/login/email-otp, textbox "One-Time
 * Password", button "Login"). Once an authenticator is enrolled it asks
 * for that instead — unverified until then.
 */
/**
 * npm 2FA is security keys only for a new enrollment (2026-09-22: the method
 * list offers nothing else). The virtual authenticator is the key; the
 * passkey and the recovery codes npm shows once are sealed with the
 * credential. Mapped live to "Add security key"; past that is unverified.
 */
const NPM_PASSKEY_SETUP: PasskeySetupSpec = {
  url: (cred) => `https://www.npmjs.com/settings/${cred.username}/tfa`,
  before: [{ role: "button", name: "/^continue/i" }],
  name: { role: "textbox", name: "/security key name/i" },
  create: { role: "button", name: "Add security key" },
  done: /recovery codes|manage security keys|two-factor authentication (is )?(enabled|on)|security key (was )?added/i,
};

/** npm's key prompt, at sign-in and before sensitive pages ("Click the button below when you are ready to authenticate"). */
const NPM_USE_KEY = { role: "button", name: "Use security key" } as const;

const npm: SiteLogin = {
  site: "npm",
  passkeySetup: NPM_PASSKEY_SETUP,
  // Five 64-hex codes, behind the key (mapped 2026-09-22).
  recoveryCodes: {
    url: (cred) => `https://www.npmjs.com/settings/${cred.username}/recovery-codes`,
    unlock: NPM_USE_KEY,
    codes: /\b[0-9a-f]{64}\b/i,
  },
  home: "https://www.npmjs.com/",
  ask: "Your npm account (npmjs.com): username, password, authenticator key if set",
  loggedIn: async (fp) =>
    /npmjs\.com/.test(fp.url()) && !(await fp.has({ role: "link", name: "Sign In" })),
  signIn: formLogin("npm", {
    start: "https://www.npmjs.com/login",
    username: { role: "textbox", name: "Username" },
    password: { role: "textbox", name: "Password" },
    submit: { role: "button", name: "Sign In" },
    passkey: { asks: /security key|ready to authenticate/i, start: NPM_USE_KEY },
    code: [
      {
        kind: "email",
        asks: /sent a one-time password to your email/i,
        field: { role: "textbox", name: "One-Time Password" },
        submit: { role: "button", name: "Login" },
        hint: "npm",
      },
      {
        kind: "totp",
        asks: /authenticator|two-factor|2fa/i,
        field: { role: "textbox", name: "/code|one-time password/i" },
        submit: { role: "button", name: "/verify|submit|continue|login/i" },
      },
    ],
    rejected: /incorrect username or password|invalid credentials/i,
    success: /npmjs\.com\/(?!login)/,
  }),
};

export const SITE_LOGINS: readonly SiteLogin[] = [
  cloudflare,
  google,
  // After google: a lookup by credential name finds google itself first.
  ...GOOGLE_APPS,
  googleAdmin,
  instantly,
  aws,
  anthropic,
  twilio,
  sentry,
  linkedin,
  instagram,
  facebook,
  x,
  tiktok,
  outlook,
  npm,
  github,
];
