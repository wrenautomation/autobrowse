/**
 * Login pages we know. Locators are visible labels, so a redesign fails
 * loudly and the repairer gets a chance. Every one is UNVERIFIED against
 * the live page until its first run; the memory layer keeps what worked.
 * Verified: cloudflare via Google (2026-09-19). Public login forms read
 * live on 2026-09-21 (headless explore): github, microsoft (first page), linkedin.
 */

import { FACEBOOK_LOGIN_URL, signInToFacebook } from "./facebook.js";
import { INSTAGRAM_LOGIN_URL, signInToInstagram } from "./instagram.js";
import { LINKEDIN_LOGIN_URL, signInToLinkedin } from "./linkedin.js";
import {
  formLogin,
  LoginFailed,
  oauthLogin,
  type PasskeySetupSpec,
  type PasswordChangeSpec,
  passwordOf,
  type SignInContext,
  type SiteLogin,
  signInToGoogle,
  type TotpSetupSpec,
} from "./login.js";
import { MICROSOFT_HOST, signInToMicrosoft } from "./microsoft.js";
import { signInToTiktok, TIKTOK_LOGIN_URL } from "./tiktok.js";
import { signInToX, X_LOGIN_URL } from "./x.js";

const CLOUDFLARE_HOME = /dash\.cloudflare\.com\/[0-9a-f]{32}/;

const cloudflarePassword = formLogin("cloudflare", {
  start: "https://dash.cloudflare.com/login",
  username: { role: "textbox", name: "Email" },
  password: { role: "textbox", name: "Password" },
  submit: { role: "button", name: "/^(log|sign) ?in$/i" },
  code: {
    kind: "totp",
    asks: /authenticator|verification code|two-factor|2fa/i,
    field: { role: "textbox", name: "/code/i" },
    submit: { role: "button", name: "/continue|verify/i" },
  },
  rejected: /incorrect email or password|invalid credentials/i,
  success: CLOUDFLARE_HOME,
});

const cloudflareGoogle = oauthLogin("cloudflare", {
  start: "https://dash.cloudflare.com/login",
  button: { role: "button", name: "/google/i" },
  success: CLOUDFLARE_HOME,
});

/**
 * Cloudflare: the stored `cloudflare` credential's password, or, when the
 * account was made with "Sign in with Google", the `google` credential
 * through that button. `via: "google"` in the cloudflare credential's
 * metadata, or no cloudflare credential at all, picks the button.
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
    if (ctx.cred.via === "google") return cloudflareGoogle(ctx);
    return cloudflarePassword(ctx);
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
const GOOGLE_SIGN_IN_HERE = { at: /accounts\.google\.com/, run: signInToGoogle };

/** The personal Google account: what "Sign in with Google" buttons use. */
const google: SiteLogin = {
  site: "google",
  home: "https://myaccount.google.com/",
  origins: ["google.com"],
  ask: 'Your Google account: the one behind every "Sign in with Google" button',
  loggedIn: async (fp) =>
    /myaccount\.google\.com/.test(fp.url()) && !/accounts\.google\.com/.test(fp.url()),
  async signIn(ctx) {
    await ctx.fp.open(
      "https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/",
      { allowWall: true },
    );
    await signInToGoogle(ctx);
    if (!(await ctx.fp.waitForUrl(/myaccount\.google\.com/, 30_000)))
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
        // A code sent for an earlier attempt is older than this sign-in: ask for a fresh one.
        await fp.act(
          { kind: "click" },
          { role: "button", name: "/^resend$/i" },
          { goal: "have Twilio text a fresh code" },
        );
        const code = await ctx.code("sms", "twilio");
        await fp.act(
          { kind: "click" },
          { id: "rememberBrowser" },
          { goal: "remember this browser" },
        );
        await fp.act({ kind: "fill", value: code }, { id: "code" }, { goal: "enter the SMS code" });
        await fp.act(
          { kind: "click" },
          { role: "button", name: "/^continue$/i" },
          { goal: "submit the code" },
        );
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
 * Unverified past the form: the second factor's page is whatever npm asks
 * for once 2FA is enrolled, and `code` covers the common shape (an
 * authenticator box that says "one-time password").
 */
const npm: SiteLogin = {
  site: "npm",
  home: "https://www.npmjs.com/",
  ask: "Your npm account (npmjs.com): username, password, authenticator key if set",
  loggedIn: async (fp) =>
    /npmjs\.com/.test(fp.url()) && !(await fp.has({ role: "link", name: "Sign In" })),
  signIn: formLogin("npm", {
    start: "https://www.npmjs.com/login",
    username: { role: "textbox", name: "Username" },
    password: { role: "textbox", name: "Password" },
    submit: { role: "button", name: "Sign In" },
    code: {
      kind: "totp",
      asks: /one-time password|authenticator|two-factor|2fa/i,
      field: { role: "textbox", name: "/code|one-time password/i" },
      submit: { role: "button", name: "/verify|submit|continue/i" },
    },
    rejected: /incorrect username or password|invalid credentials/i,
    success: /npmjs\.com\/(?!login)/,
  }),
};

export const SITE_LOGINS: readonly SiteLogin[] = [
  cloudflare,
  google,
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
];
