/**
 * The OAuth consent walk most sites share: sign in on the site's home,
 * open the authorize URL, let the runner sign in again if the site shows
 * its login under it (the redirect back to the consent rides in that
 * URL), press the one allow button, land on the redirect. Google's has
 * more pages (`oauth-consent.ts`); LinkedIn, Instagram and TikTok are this.
 */
import { type BrowserFlow, defineFlow } from "../flow.js";
import type { Hints } from "../locate.js";
import { CONSENT_RECEIVED, type OauthConsentInput, redirectOf } from "./oauth-consent.js";

const SETTLE_MS = 1_500;

export interface ConsentWalk {
  site: string;
  /** A signed-in page to open first, so the authorize page is the consent, not a login. */
  home: string;
  /** The site's login pages: the authorize URL landing here means the runner must sign in. */
  loginUrl: RegExp;
  /** The button that grants. */
  allow: Hints;
  /**
   * A box to tick before the allow button wakes up ("I trust this app"):
   * `tick` (its label: the input itself is often hidden under a drawn box)
   * is pressed only while `unticked` shows.
   */
  confirm?: { unticked: Hints; tick: Hints };
  /** Page text that means the site refused the request (bad client, bad redirect). */
  refused: RegExp;
  rounds?: number;
}

export function consentFlow(w: ConsentWalk): BrowserFlow<OauthConsentInput, { landed: string }> {
  return defineFlow<OauthConsentInput, { landed: string }>({
    site: w.site,
    name: "oauth-consent",
    async run(fp, input) {
      const redirect = redirectOf(input.url);
      const landed = (u: string) => u.startsWith(redirect);
      await fp.answer(redirect, CONSENT_RECEIVED);
      await fp.open(w.home);
      await fp.open(input.url, { allowWall: true });
      // Still a login (the session did not carry): let the runner sign in on this very
      // page, whose redirect brings the walk back to the consent.
      if (w.loginUrl.test(fp.url())) await fp.open(input.url);
      for (let round = 0; round < (w.rounds ?? 6); round++) {
        if (landed(fp.url())) return { landed: fp.url() };
        await fp.wait(SETTLE_MS);
        // A wait, so it clears interrupts (a banner, a click learned on the site) off the button.
        const allow = await fp.has(w.allow, SETTLE_MS);
        if (landed(fp.url())) return { landed: fp.url() };
        const text = await fp.text();
        if (allow) {
          // A click before the page wakes up is lost (X, 2026-09-27): look again, press again.
          for (let n = 0; w.confirm && n < 3 && (await fp.has(w.confirm.unticked)); n++) {
            await fp.act({ kind: "click" }, w.confirm.tick, { goal: "tick the acknowledgement" });
            await fp.wait(1_000);
          }
          if (w.confirm && (await fp.has(w.confirm.unticked)))
            return fp.human(`${w.site}: the acknowledgement box would not tick`);
          await fp.act({ kind: "click" }, w.allow, { goal: "consent" });
          await fp.waitForUrl(landed, 10_000);
          continue;
        }
        if (w.refused.test(text))
          return fp.human(`${w.site} refused the consent: ${text.slice(0, 200)}`);
      }
      if (landed(fp.url())) return { landed: fp.url() };
      return fp.human(`still on ${fp.url()} after the consent walk`);
    },
  });
}
