/**
 * The browser half of `wrangler login`: the CLI prints an authorize URL and
 * waits on its localhost callback (8976). The signed-in Cloudflare session
 * opens it and clicks Authorize; Cloudflare redirects to the callback and the
 * CLI stores its own token. Nothing passes through here but the click.
 * Mapped 2026-09-27 in explore: "Select account(s)" loads, then the consent
 * form "Wrangler wants to access your account" with button "Authorize";
 * granted lands on welcome.developers.workers.dev/wrangler-oauth-consent-granted.
 */
import { defineFlow } from "../flow.js";

export interface WranglerLoginInput {
  /** The URL `wrangler login --browser=false` printed. */
  url: string;
}

const AUTHORIZE = { role: "button", name: "Authorize" } as const;
const GRANTED = /wrangler-oauth-consent-granted|localhost:8976\/oauth\/callback/;
const CONSENT_MS = 60_000;

export const wranglerLogin = defineFlow<WranglerLoginInput, { granted: true }>({
  site: "cloudflare",
  name: "wrangler-login",
  async run(fp, { url }) {
    // Signed out: the wall signs in, and the dashboard may not return to the consent.
    await fp.open(url, { allowWall: true });
    if (!(await fp.has(AUTHORIZE, CONSENT_MS))) {
      await fp.open(url, { allowWall: true });
      if (!(await fp.has(AUTHORIZE, CONSENT_MS)))
        return fp.human(`no Authorize button at ${fp.url().split("?")[0]}`);
    }
    await fp.act({ kind: "click" }, AUTHORIZE, { goal: "authorize wrangler" });
    if (!(await fp.waitForUrl(GRANTED, 30_000)))
      return fp.human(`not granted: still at ${fp.url().split("?")[0]}`);
    return { granted: true };
  },
});
