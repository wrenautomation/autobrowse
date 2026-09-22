/**
 * Mint an npm publish token on npmjs.com. Granular tokens are website-only —
 * the registry's token API (`/-/npm/v1/tokens`) mints the classic kind — so
 * this is the door, and it is a page.
 *
 * Mapped live 2026-09-22 (headed; headless npmjs.com sits on a Cloudflare
 * check) at /settings/<user>/tokens/granular-access-tokens/new:
 *   textbox "Token name"            unique, 40 characters at most
 *   checkbox "Bypass two-factor…"   an account with no 2FA can publish only
 *                                   with this ticked: npm answers 403
 *                                   "Two-factor authentication or granular
 *                                   access token with bypass 2fa enabled is
 *                                   required to publish packages"
 *   radio "Read and write (publish and stage)" / "(stage only)"
 *   radio "All packages"            appears once write is picked
 *   summary[aria-controls=expiration-days-menu]
 *                                   a menu of menuitemcheckbox "7 days" …
 *                                   "90 days"; write tokens default to 7
 *   button "Generate token"
 *
 * npm is ending direct publishing with bypass tokens (Jan 2027) in favour
 * of staged publishing and trusted publishing from CI; `access: "stage"`
 * is that path once the packages publish from CI.
 */
import type { SecretSink } from "../../deps/sink.js";
import { NPM_TOKEN } from "../../sites/npm.js";
import { defineFlow, type FlowPage } from "../flow.js";

export type NpmTokenAccess = "publish" | "stage";

export interface GranularTokenInput {
  /** Named on the page with today's date after it, since npm wants every name unique. */
  name: string;
  /** Publish directly, or stage for approval. */
  access?: NpmTokenAccess;
  /** Skip 2FA when publishing: the only way to publish from an account without 2FA. */
  bypass2fa?: boolean;
  /** 7, 30, 60 or 90 (npm's maximum for a write token). */
  expiresDays?: 7 | 30 | 60 | 90;
  /** Where the token is kept when a setup step runs this; the token is never printed. */
  sink?: SecretSink;
}

export interface GranularTokenResult {
  token: string;
  /** The account the token publishes as, read off the page. */
  user: string;
}

/** Every npm token is `npm_` and 36 url-safe characters. */
const TOKEN = /\bnpm_[A-Za-z0-9]{36}\b/;

const ACCESS: Record<NpmTokenAccess, string> = {
  publish: "Read and write (publish and stage)",
  stage: "Read and write (stage only)",
};

/** The signed-in header links to the account's own page, `/~<user>`. */
async function signedInUser(fp: FlowPage): Promise<string | null> {
  const href = await fp.page
    .locator('a[href^="/~"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  return href?.slice(2) || null;
}

/** `autobrowse publish 2026-09-22 14:05`: unique per minute, inside npm's 40. */
export function tokenName(name: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `${name.slice(0, 40 - stamp.length - 1)} ${stamp}`;
}

export const npmGranularToken = defineFlow<GranularTokenInput, GranularTokenResult>({
  site: "npm",
  name: "granular-token",
  async run(fp, input) {
    await fp.open("https://www.npmjs.com/settings");
    const user = await signedInUser(fp);
    if (!user) return fp.human("npmjs.com does not show a signed-in account");
    await fp.open(`https://www.npmjs.com/settings/${user}/tokens/granular-access-tokens/new`);
    await fp.act(
      { kind: "fill", value: tokenName(input.name, new Date()) },
      { role: "textbox", name: "Token name" },
      { goal: "name the token" },
    );
    if (input.bypass2fa ?? true)
      await fp.act(
        { kind: "click" },
        { role: "checkbox", name: "/bypass two-factor/i" },
        { goal: "let it publish without a 2FA code" },
      );
    await fp.act(
      { kind: "click" },
      { role: "radio", name: ACCESS[input.access ?? "publish"] },
      { goal: "give it write" },
    );
    await fp.act(
      { kind: "click" },
      { role: "radio", name: "All packages" },
      { goal: "cover every package the account owns, and future ones" },
    );
    await fp.act(
      { kind: "click" },
      { css: 'summary[aria-controls="expiration-days-menu"]' },
      { goal: "open the expiry menu" },
    );
    await fp.act(
      { kind: "click" },
      { role: "menuitemcheckbox", name: `${input.expiresDays ?? 90} days` },
      { goal: "set how long it lives" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Generate token" },
      { goal: "mint the token", irreversible: true },
    );
    // The token is shown once, on the next page; after that npm keeps only its last four.
    let token: string | undefined;
    for (let i = 0; i < 10 && !token; i++) {
      await fp.wait(1_500);
      token = (await fp.text()).match(TOKEN)?.[0] ?? (await fp.html()).match(TOKEN)?.[0];
    }
    if (!token) return fp.human("the token page did not show a token");
    await input.sink?.put(NPM_TOKEN, token);
    return { token, user };
  },
});
