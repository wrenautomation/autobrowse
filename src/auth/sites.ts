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

/** accounts.google.com fronts every Google surface; the admin console is one of them. */
const googleAdmin: SiteLogin = {
  site: "google-admin",
  credential: "google",
  home: "https://admin.google.com/",
  loggedIn: async (fp) =>
    /admin\.google\.com/.test(fp.url()) && !/accounts\.google\.com/.test(fp.url()),
  async signIn(ctx) {
    await ctx.fp.open(
      "https://accounts.google.com/ServiceLogin?continue=https://admin.google.com/",
      {
        allowWall: true,
      },
    );
    await signInToGoogle(ctx);
    if (!(await ctx.fp.waitForUrl(/admin\.google\.com/, 30_000)))
      throw new LoginFailed("google-admin", `still on ${ctx.fp.url()} after Google sign-in`);
  },
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

export const SITE_LOGINS: readonly SiteLogin[] = [cloudflare, googleAdmin, instantly];
