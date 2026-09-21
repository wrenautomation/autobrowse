/**
 * X's OAuth 2.0 authorize page: after the account's sign-in, the app's
 * permissions with "Authorize app". From the docs 2026-09-22; unproven
 * until a developer app and an account exist.
 */
import { X_LOGIN_URL } from "../../auth/x.js";
import { consentFlow } from "./consent-walker.js";

export const xOauthConsent = consentFlow({
  site: "x",
  home: "https://x.com/home",
  loginUrl: X_LOGIN_URL,
  allow: { role: "button", name: "/^(authorize app|authorize|allow)$/i" },
  refused: /something went wrong|invalid|unauthorized|not authorized|error|could not authenticate/i,
});
