/**
 * A Google OAuth consent from the authorize URL to the redirect, for any
 * client and scopes. The runner signs the profile in when Google asks
 * (`google` credential, TOTP); this walks what comes after, in whatever
 * order Google shows it: the account chooser, the "hasn't verified this
 * app" warning of an app in testing, the scope checkboxes (sensitive scopes
 * start unticked), and the Continue/Allow buttons, until the page is the
 * redirect (our loopback listener answers it). Mapped 2026-09-20.
 */
import { defineFlow } from "../flow.js";

export interface OauthConsentInput {
  /** The full authorize URL (client id, scopes, state, redirect). */
  url: string;
  /** Which account to pick in the chooser; the signed-in one when absent. */
  account?: string;
}

const SIGNED_IN_PAGE = "https://myaccount.google.com/";
const SETTLE_MS = 1_500;
const ROUNDS = 12;
/** Google's re-verification pages, the passkey ceremony and its error among them. */
const CHALLENGE = /accounts\.google\.com\/(v3\/)?signin\/challenge\//;

/** `redirect_uri` from the authorize URL, so the walk knows where it ends. */
export function redirectOf(authorizeUrl: string): string {
  const r = new URL(authorizeUrl).searchParams.get("redirect_uri");
  if (!r) throw new Error("authorize url has no redirect_uri");
  return r;
}

export const googleOauthConsent = defineFlow<OauthConsentInput, { landed: string }>({
  site: "google",
  name: "oauth-consent",
  async run(fp, input) {
    const redirect = redirectOf(input.url);
    const landed = (u: string) => u.startsWith(redirect);
    // Sign in on a plain page first: the consent pages live on accounts.google.com
    // too, and the runner's sign-in would otherwise take each of them for a wall.
    await fp.open(SIGNED_IN_PAGE);
    await fp.open(input.url, { allowWall: true });
    let verified = false;
    for (let round = 0; round < ROUNDS; round++) {
      if (landed(fp.url())) return { landed: fp.url() };
      await fp.wait(SETTLE_MS);
      if (landed(fp.url())) return { landed: fp.url() };
      const text = await fp.text();
      // Before sensitive scopes Google verifies the person again, in the
      // middle of the walk ("Verify it's you", challenge/pk, and pk/error
      // when it asks for a passkey it does not hold). Navigating away would
      // lose the URL that carries the consent, so the sign-in answers the
      // wall on this very page, as the account being consented for.
      if (CHALLENGE.test(fp.url())) {
        if (verified) return fp.human(`Google keeps re-verifying: ${fp.url()}`);
        verified = true;
        const how = await fp.signIn("google", input.account);
        if (how !== "signed-in") return fp.human(`Google re-verification: ${how}`);
        continue;
      }
      if (/choose an account/i.test(text)) {
        const pick = input.account ? { text: input.account } : { css: "[data-identifier]" };
        if (!(await fp.has(pick)))
          return fp.human(`the account chooser does not list ${input.account ?? "any account"}`);
        await fp.act({ kind: "click" }, pick, { goal: "pick the account" });
        continue;
      }
      // An app in testing: "Google hasn't verified this app" → Continue (sometimes behind "Advanced").
      if (/hasn.t verified this app/i.test(text)) {
        const advanced = { role: "button", name: "/^advanced$/i" } as const;
        if (await fp.has(advanced)) await fp.act({ kind: "click" }, advanced, { goal: "advanced" });
        const go = { css: 'a:has-text("(unsafe)"), button:has-text("Continue")' } as const;
        await fp.act({ kind: "click" }, go, { goal: "past the unverified-app warning" });
        continue;
      }
      // Scope checkboxes: every unticked one is ticked (the "Select all" box, when there is one, does it in one go).
      const unticked = {
        css: '[role=checkbox][aria-checked="false"], input[type=checkbox]:not(:checked)',
      };
      if (await fp.has(unticked)) {
        const all = {
          css: '[role=checkbox][aria-checked="false"]:has-text("Select all"), label:has-text("Select all") [role=checkbox][aria-checked="false"]',
        };
        if (await fp.has(all)) await fp.act({ kind: "click" }, all, { goal: "select all scopes" });
        for (let i = 0; i < 20 && (await fp.has(unticked)); i++)
          await fp.act({ kind: "click" }, unticked, { goal: "grant a scope" });
      }
      const go = { role: "button", name: "/^(continue|allow|confirm)$/i" } as const;
      if (await fp.has(go)) {
        await fp.act({ kind: "click" }, go, { goal: "consent" });
        await fp.waitForUrl(landed, 10_000);
        continue;
      }
      if (/access blocked|invalid_client|redirect_uri_mismatch|error 4\d\d/i.test(text))
        return fp.human(`Google refused the consent: ${text.slice(0, 200)}`);
    }
    if (landed(fp.url())) return { landed: fp.url() };
    return fp.human(`still on ${fp.url()} after the consent walk`);
  },
});
