/**
 * A LinkedIn OAuth consent from the authorize URL to the redirect. A
 * signed-out profile gets LinkedIn's login page under the authorize URL
 * (/uas/login?session_redirect=…); the runner signs in there (`linkedin`
 * credential, `signInHere`) and comes back. Then the one page: "<app>
 * would like to access…" with Allow. Unverified until a LinkedIn app and
 * credential exist (mapped from LinkedIn's OAuth docs 2026-09-21).
 */
import { LINKEDIN_LOGIN_URL } from "../../auth/linkedin.js";
import { defineFlow } from "../flow.js";
import { type OauthConsentInput, redirectOf } from "./oauth-consent.js";

const FEED = "https://www.linkedin.com/feed/";
const SETTLE_MS = 1_500;
const ROUNDS = 6;

export const linkedinOauthConsent = defineFlow<OauthConsentInput, { landed: string }>({
  site: "linkedin",
  name: "oauth-consent",
  async run(fp, input) {
    const redirect = redirectOf(input.url);
    const landed = (u: string) => u.startsWith(redirect);
    // Signed in on the feed first, so the authorize page is the consent, not a login.
    await fp.open(FEED);
    await fp.open(input.url, { allowWall: true });
    // Still a login (the session did not carry): let the runner sign in on this very
    // page, whose session_redirect brings the walk back to the consent.
    if (LINKEDIN_LOGIN_URL.test(fp.url())) await fp.open(input.url);
    for (let round = 0; round < ROUNDS; round++) {
      if (landed(fp.url())) return { landed: fp.url() };
      await fp.wait(SETTLE_MS);
      if (landed(fp.url())) return { landed: fp.url() };
      const text = await fp.text();
      const allow = { role: "button", name: "/^(allow|continue)$/i" } as const;
      if (await fp.has(allow)) {
        await fp.act({ kind: "click" }, allow, { goal: "consent" });
        await fp.waitForUrl(landed, 10_000);
        continue;
      }
      if (/something went wrong|invalid|unauthorized|not authorized|error/i.test(text))
        return fp.human(`LinkedIn refused the consent: ${text.slice(0, 200)}`);
    }
    if (landed(fp.url())) return { landed: fp.url() };
    return fp.human(`still on ${fp.url()} after the consent walk`);
  },
});
