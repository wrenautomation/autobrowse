/**
 * Mint the publish token on npmjs.com. Granular tokens are website-only —
 * the registry's token API (`/-/npm/v1/tokens`) mints the classic kind,
 * and those are what npm is restricting (account changes Aug 2026, direct
 * publishing Jan 2027) — so this is the door, and it is a page.
 *
 * UNMAPPED against the live page: npm's settings pages need an account,
 * and the account is a `needs` row until a person makes it (signup is
 * behind a bot check). Written from npm's documented flow; the first real
 * run either works or drops a failure the repairer picks up.
 */
import type { SecretSink } from "../../deps/sink.js";
import { NPM_TOKEN } from "../../sites/npm.js";
import { defineFlow, type FlowPage } from "../flow.js";

export interface GranularTokenInput {
  /** The token's name on the page; a fresh token is minted each run. */
  name: string;
  /** How long npm should let it live; npm's own maximum stands when this is higher. */
  expiresDays?: number;
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

/** The signed-in header links to the account's own page, `/~<user>`. */
async function signedInUser(fp: FlowPage): Promise<string | null> {
  const href = await fp.page
    .locator('a[href^="/~"]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  return href?.slice(2) || null;
}

export const npmGranularToken = defineFlow<GranularTokenInput, GranularTokenResult>({
  site: "npm",
  name: "granular-token",
  async run(fp, input) {
    await fp.open("https://www.npmjs.com/");
    const user = await signedInUser(fp);
    if (!user) return fp.human("npmjs.com does not show a signed-in account");
    await fp.open(`https://www.npmjs.com/settings/${user}/tokens/granular-access-tokens/new`);
    await fp.act(
      { kind: "fill", value: input.name },
      { role: "textbox", name: "/token name/i" },
      {
        goal: "name the token",
      },
    );
    if (input.expiresDays !== undefined)
      await fp.act(
        { kind: "fill", value: String(input.expiresDays) },
        { role: "spinbutton", name: "/expir/i" },
        { goal: "set how long it lives" },
      );
    // Publishing needs write on the packages; nothing else is asked for.
    await fp.act(
      { kind: "click" },
      { role: "radio", name: "/read and write/i" },
      { goal: "give it write" },
    );
    await fp.act(
      { kind: "click" },
      { role: "radio", name: "/all packages/i" },
      { goal: "cover every package the account owns" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/generate token/i" },
      { goal: "mint the token", irreversible: true },
    );
    await fp.wait(2_000);
    // The token is shown once, in a copy box; after this page it is gone.
    const token = (await fp.text()).match(TOKEN)?.[0] ?? (await fp.html()).match(TOKEN)?.[0];
    if (!token) return fp.human("the token page did not show a token");
    await input.sink?.put(NPM_TOKEN, token);
    return { token, user };
  },
});
