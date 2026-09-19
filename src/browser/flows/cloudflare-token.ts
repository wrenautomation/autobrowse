/**
 * Mint the API token the domain workflow needs, from the dashboard, and
 * read the account id off the URL. Both are things a person did once by
 * hand; now the credential ladder does them. UNVERIFIED against the live
 * dashboard until the first run; hints are visible labels so a redesign
 * fails loudly and the repairer gets a go.
 */
import { defineFlow } from "../flow.js";

/** A signed-in dashboard URL carries the account id. */
export const cloudflareAccountId = defineFlow<undefined, { accountId: string }>({
  site: "cloudflare",
  name: "account-id",
  async run(fp) {
    await fp.open("https://dash.cloudflare.com/?to=/:account/home");
    await fp.wait(1_000);
    const id = fp.url().match(/dash\.cloudflare\.com\/([0-9a-f]{32})/)?.[1];
    if (!id) return fp.human("no account id in the dashboard URL");
    return { accountId: id };
  },
});

export interface TokenPermission {
  /** "Account" | "User" | "Zone" */
  scope: string;
  /** "DNS", "Zone", "Domain Registrar", ... as the dropdown shows them. */
  name: string;
  /** "Read" | "Edit" */
  level: string;
}

export interface TokenInput {
  /** The token's name in the dashboard; rerunning reuses nothing, a new token is minted each time. */
  name: string;
  permissions: TokenPermission[];
}

export interface TokenResult {
  token: string;
}

/** What Cloudflare API tokens look like; the page shows it once. */
const TOKEN = /\b[A-Za-z0-9_-]{40}\b/;

export const cloudflareApiToken = defineFlow<TokenInput, TokenResult>({
  site: "cloudflare",
  name: "api-token",
  async run(fp, { name, permissions }) {
    await fp.open("https://dash.cloudflare.com/profile/api-tokens");
    await fp.act(
      { kind: "click" },
      { role: "link", name: "/create token/i" },
      { goal: "start creating a token" },
    );
    // The custom template's button sits in a row that says "Custom token".
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/get started/i" },
      { goal: "choose the custom token template" },
    );
    await fp.act(
      { kind: "fill", value: name },
      { role: "textbox", name: "/token name/i" },
      { goal: "name the token" },
    );
    for (const [i, p] of permissions.entries()) {
      if (i > 0)
        await fp.act(
          { kind: "click" },
          { role: "button", name: "/add more/i" },
          { goal: "add a permission row" },
        );
      // Three dropdowns per row; the nth row's controls carry the row index in their names on the current dashboard.
      await fp.act(
        { kind: "select", value: p.scope },
        { role: "combobox", name: `/permission.*${i + 1}.*scope|scope.*${i + 1}/i` },
        { goal: `row ${i + 1}: scope ${p.scope}` },
      );
      await fp.act(
        { kind: "select", value: p.name },
        { role: "combobox", name: `/permission.*${i + 1}.*(name|type)|(name|type).*${i + 1}/i` },
        { goal: `row ${i + 1}: ${p.name}` },
      );
      await fp.act(
        { kind: "select", value: p.level },
        { role: "combobox", name: `/permission.*${i + 1}.*level|level.*${i + 1}/i` },
        { goal: `row ${i + 1}: ${p.level}` },
      );
    }
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/continue to summary/i" },
      { goal: "go to the summary" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/create token/i" },
      { goal: "create the token", irreversible: true },
    );
    await fp.wait(1_500);
    const token = (await fp.text()).match(TOKEN)?.[0];
    if (!token) return fp.human("token page did not show a token");
    return { token };
  },
});
