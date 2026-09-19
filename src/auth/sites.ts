/**
 * Login pages we know. Locators are visible labels, so a redesign fails
 * loudly and the repairer gets a chance. Every one is UNVERIFIED against
 * the live page until its first run; the memory layer keeps what worked.
 */
import { formLogin, type SiteLogin } from "./login.js";

const cloudflare: SiteLogin = {
  site: "cloudflare",
  home: "https://dash.cloudflare.com/",
  loggedIn: async (fp) =>
    /dash\.cloudflare\.com\/(?!login|sign-up)/.test(fp.url()) &&
    !(await fp.has({ role: "textbox", name: "Password" })),
  signIn: formLogin("cloudflare", {
    start: "https://dash.cloudflare.com/login",
    username: { role: "textbox", name: "Email" },
    password: { role: "textbox", name: "Password" },
    submit: { role: "button", name: "/^log ?in$/i" },
    code: {
      kind: "totp",
      asks: /authenticator|verification code|two-factor|2fa/i,
      field: { role: "textbox", name: "/code/i" },
      submit: { role: "button", name: "/continue|verify/i" },
    },
    rejected: /incorrect email or password|invalid credentials/i,
    success: /dash\.cloudflare\.com\/[0-9a-f]{32}|Account Home|Websites/i,
  }),
};

/** accounts.google.com fronts every Google surface; the admin console is one of them. */
const googleAdmin: SiteLogin = {
  site: "google-admin",
  home: "https://admin.google.com/",
  loggedIn: async (fp) =>
    /admin\.google\.com/.test(fp.url()) && !/accounts\.google\.com/.test(fp.url()),
  signIn: formLogin("google-admin", {
    start: "https://accounts.google.com/ServiceLogin?continue=https://admin.google.com/",
    username: { role: "textbox", name: "/email or phone/i" },
    next: { role: "button", name: "Next" },
    password: { role: "textbox", name: "/password/i" },
    submit: { role: "button", name: "Next" },
    code: {
      kind: "totp",
      asks: /Google Authenticator|enter the code|2-Step Verification/i,
      field: { role: "textbox", name: "/code/i" },
      submit: { role: "button", name: "Next" },
    },
    rejected: /wrong password|couldn.t find your google account/i,
    success: /admin\.google\.com/,
  }),
};

const instantly: SiteLogin = {
  site: "instantly",
  home: "https://app.instantly.ai/",
  loggedIn: async (fp) => /app\.instantly\.ai\/app/.test(fp.url()),
  signIn: formLogin("instantly", {
    start: "https://app.instantly.ai/auth/login",
    username: { role: "textbox", name: "Email" },
    password: { role: "textbox", name: "Password" },
    submit: { role: "button", name: "/^log ?in$/i" },
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
