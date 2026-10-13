/**
 * Threads' OAuth dialog, walked in the Instagram profile: a Threads profile
 * signs in through its Instagram account, so threads.com is already signed in
 * there. "<app> wants access" with Allow (or Continue). The app must list the
 * profile as an accepted Threads Tester until it passes review.
 */
import { consentFlow } from "./consent-walker.js";

export const threadsOauthConsent = consentFlow({
  site: "instagram",
  name: "threads-consent",
  home: "https://www.threads.com/",
  loginUrl: /threads\.(?:net|com)\/login|instagram\.com\/accounts\/login/,
  allow: { role: "button", name: "/^(allow|continue)$/i" },
  refused: /invalid|not authorized|something went wrong|error|not a tester|app is not set up/i,
});
