/**
 * A LinkedIn OAuth consent from the authorize URL to the redirect. A
 * signed-out profile gets LinkedIn's login page under the authorize URL
 * (/uas/login?session_redirect=…); the runner signs in there (`linkedin`
 * credential, `signInHere`) and comes back. Then the one page: "<app>
 * would like to access…" with Allow. Unverified until a LinkedIn app and
 * credential exist (mapped from LinkedIn's OAuth docs 2026-09-21).
 */
import { LINKEDIN_LOGIN_URL } from "../../auth/linkedin.js";
import { consentFlow } from "./consent-walker.js";

export const linkedinOauthConsent = consentFlow({
  site: "linkedin",
  home: "https://www.linkedin.com/feed/",
  loginUrl: LINKEDIN_LOGIN_URL,
  allow: { role: "button", name: "/^(allow|continue)$/i" },
  refused: /something went wrong|invalid|unauthorized|not authorized|error/i,
});
