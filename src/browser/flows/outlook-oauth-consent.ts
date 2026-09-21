/**
 * Microsoft's consent: signed in on Outlook on the web, the authorize URL
 * shows "Permissions requested" with Accept (a "Stay signed in?" prompt
 * may sit before it; the microsoft sign-in answers that when it signs in).
 */
import { consentFlow } from "./consent-walker.js";

/** Microsoft's login pages proper; the authorize URL is on the same host but is the consent, not a login. */
const MICROSOFT_LOGIN = /login\.live\.com\/|microsoftonline\.com\/[^/]+\/login/;

export const outlookOauthConsent = consentFlow({
  site: "outlook",
  home: "https://outlook.live.com/mail/0/",
  loginUrl: MICROSOFT_LOGIN,
  allow: { role: "button", name: "/^(accept|yes|continue)$/i" },
  refused: /AADSTS\d+|invalid|unauthorized|not authorized|something went wrong|error/i,
});
