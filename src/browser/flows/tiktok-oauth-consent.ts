/**
 * TikTok's Login Kit authorize page: after the account's sign-in, the
 * app's scopes with Authorize. Proven on the sandbox app 2026-10-14. Its
 * button starts disabled and its grant request sometimes stalls: two tries,
 * a reload between, never a second sign-in.
 */
import { TIKTOK_LOGIN_URL } from "../../auth/tiktok.js";
import { consentFlow } from "./consent-walker.js";

export const tiktokOauthConsent = consentFlow({
  site: "tiktok",
  home: "https://www.tiktok.com/foryou",
  loginUrl: TIKTOK_LOGIN_URL,
  allow: { role: "button", name: "/^(authorize|continue|allow)$/i" },
  refused: /invalid|unauthorized|something went wrong|error|not registered/i,
  rounds: 2,
  ready: { css: "#auth-btn", settleMs: 5_000, spinMs: 15_000 },
});
