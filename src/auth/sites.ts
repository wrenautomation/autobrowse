/**
 * Login pages we know. Locators are visible labels, so a redesign fails
 * loudly and the repairer gets a chance. Every one is UNVERIFIED against
 * the live page until its first run; the memory layer keeps what worked.
 * Verified: cloudflare via Google (2026-09-19).
 */
import {
  formLogin,
  LoginFailed,
  oauthLogin,
  type PasswordChangeSpec,
  type SignInContext,
  type SiteLogin,
  signInToGoogle,
  type TotpSetupSpec,
} from "./login.js";

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

/** Google re-asks for the password on security pages; answer on the spot. */
const GOOGLE_SIGN_IN_HERE = { at: /accounts\.google\.com/, run: signInToGoogle };

/** The personal Google account: what "Sign in with Google" buttons use. */
const google: SiteLogin = {
  site: "google",
  home: "https://myaccount.google.com/",
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

export const SITE_LOGINS: readonly SiteLogin[] = [cloudflare, google, googleAdmin, instantly];
