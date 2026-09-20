/**
 * Mint the API token the domain workflow needs, from the dashboard, and
 * read the account id off the URL. Both are things a person did once by
 * hand; now the credential ladder does them. Mapped against the live
 * dashboard in explore mode on 2026-09-19 (recordings/cloudflare-api-token-explore).
 */
import { defineFlow, type FlowPage } from "../flow.js";

/**
 * One permission row, mapped 2026-09-19 in explore mode. Rows repeat the
 * same three controls, so row i is the i-th of each:
 *   button "Resources"            Downshift; options carry role=option
 *   textbox "Permissions"         Downshift with a typed filter
 *   combobox "Permissions levels" React Select; its input is hidden, so
 *                                 the `.react-select__control` that owns
 *                                 it is clicked; the menu is `.react-select__menu`
 * Everything goes through `fp.act`: paced, repaired, in the artifacts.
 */
async function fillPermissionRow(fp: FlowPage, i: number, p: TokenPermission): Promise<void> {
  const option = (text: string) => ({ css: `[role=listbox] [role=option]:text-is("${text}")` });
  await fp.act(
    { kind: "click" },
    { role: "button", name: "Resources", nth: i },
    { goal: `row ${i}: open the scope menu` },
  );
  await fp.act({ kind: "click" }, option(p.scope), { goal: `row ${i}: scope ${p.scope}` });
  await fp.act(
    { kind: "fill", value: p.name },
    { role: "textbox", name: "Permissions", nth: i },
    { goal: `row ${i}: filter permissions` },
  );
  await fp.act({ kind: "click" }, option(p.name), { goal: `row ${i}: permission ${p.name}` });
  await fp.act(
    { kind: "click" },
    {
      css: `input[aria-label="Permissions levels"] >> nth=${i} >> xpath=ancestor::*[contains(@class,'react-select__control')][1]`,
    },
    { goal: `row ${i}: open the level menu` },
  );
  await fp.act(
    { kind: "click" },
    { css: `.react-select__menu >> text="${p.level}"` },
    { goal: `row ${i}: level ${p.level}` },
  );
}

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
  /** Exactly as the dropdown shows it: "DNS", "Zone", "Registrar: Domains", ... */
  name: string;
  /** "Read" | "Edit", or "Admin" where the group offers that instead. */
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

/** The reveal page prints a curl line; the token is what follows Bearer (53 chars in 2026). */
const TOKEN = /Bearer ([A-Za-z0-9_-]{32,})/;

export const cloudflareApiToken = defineFlow<TokenInput, TokenResult>({
  site: "cloudflare",
  name: "api-token",
  async run(fp, { name, permissions }) {
    await fp.open("https://dash.cloudflare.com/profile/api-tokens");
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/create token/i" },
      { goal: "start creating a token" },
    );
    // The custom template's button sits in a row that says "Custom token".
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/get started/i" },
      { goal: "choose the custom token template" },
    );
    // The name box has no label; it is the form's `name` input.
    await fp.act(
      { kind: "fill", value: name },
      { css: 'input[name="name"]' },
      { goal: "name the token" },
    );
    for (const [i, p] of permissions.entries()) {
      if (i > 0)
        await fp.act(
          { kind: "click" },
          { role: "button", name: "Add more" },
          { goal: "add a permission row" },
        );
      await fillPermissionRow(fp, i, p);
    }
    await fp.act(
      { kind: "click" },
      { role: "button", name: "/continue to summary/i" },
      { goal: "go to the summary" },
    );
    await fp.act(
      { kind: "click" },
      { role: "button", name: "Create Token" },
      { goal: "create the token", irreversible: true },
    );
    // The button greys out while the request runs, then the page swaps to
    // the reveal: a heading, the token, and a curl line to test it with.
    await fp.page
      .getByRole("heading", { name: /successfully created/i })
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    const token = (
      await fp.page
        .locator("main code")
        .innerText()
        .catch(() => "")
    ).match(TOKEN)?.[1];
    if (!token) return fp.human("token page did not show a token");
    return { token };
  },
});
