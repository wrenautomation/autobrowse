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
  url: "https://myaccount.google.com/two-step-verification/authenticator",
  reveal: [
    { role: "button", name: "Set up authenticator" },
    { role: "button", name: "/can.t scan it/i" },
  ],
  toCode: [{ role: "button", name: "Next" }],
  code: { role: "textbox", name: "/enter code/i" },
  confirm: { role: "button", name: "Verify" },
  done: /authenticator app added|authenticator app.*(on|set up)|turned on/i,
};

/** The personal Google account: what "Sign in with Google" buttons use. */
const google: SiteLogin = {
  site: "google",
  home: "https://myaccount.google.com/",
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
  totpSetup: GOOGLE_TOTP_SETUP,
};

/**
 * The Workspace admin console: its own credential, a Workspace admin of
 * the domains (a personal Gmail signs in fine and then gets "Sign in with
 * an administrator account").
 */
const googleAdmin: SiteLogin = {
  site: "google-admin",
  home: "https://admin.google.com/",
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
  totpSetup: GOOGLE_TOTP_SETUP,
};

const instantly: SiteLogin = {
  site: "instantly",
  home: "https://app.instantly.ai/",
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
