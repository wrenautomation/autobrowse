/**
 * TikTok's Login Kit authorize page: after the account's sign-in, the
 * app's scopes with Authorize. From the docs 2026-09-21; unproven until an
 * app and an account exist.
 */
import { TIKTOK_LOGIN_URL } from "../../auth/tiktok.js";
import { consentFlow } from "./consent-walker.js";

export const tiktokOauthConsent = consentFlow({
  site: "tiktok",
  home: "https://www.tiktok.com/foryou",
  loginUrl: TIKTOK_LOGIN_URL,
  allow: { role: "button", name: "/^(authorize|continue|allow)$/i" },
  refused: /invalid|unauthorized|something went wrong|error|not registered/i,
});
