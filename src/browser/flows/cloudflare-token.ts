/**
 * Mint the API token the domain workflow needs, from the dashboard, and
 * read the account id off the URL. Both are things a person did once by
 * hand; now the credential ladder does them. Mapped against the live
 * dashboard in explore mode on 2026-09-19 (recordings/cloudflare-api-token-explore).
 */
import { defineFlow, type FlowPage } from "../flow.js";

/**
 * One permission row. Remapped 2026-09-28 in explore mode (the form moved
 * to Base UI): every control is a combobox named "Resources",
 * "Permissions" or "Permissions levels", repeated per row, so row i is the
 * i-th of each. A click opens the list and every option is rendered, so an
 * option is clicked by its name (a plain string matches exactly): no typed filter (typing into an open
 * list times out behind its overlay).
 * Everything goes through `fp.act`: paced, repaired, in the artifacts.
 */
async function fillPermissionRow(fp: FlowPage, i: number, p: TokenPermission): Promise<void> {
  const pick = async (control: string, value: string, goal: string) => {
    await fp.act(
      { kind: "click" },
      { role: "combobox", name: control, nth: i },
      { goal: `row ${i}: open ${goal}` },
    );
    await fp.act(
      { kind: "click" },
      { role: "option", name: value },
      { goal: `row ${i}: ${goal} ${value}` },
    );
  };
  await pick("Resources", p.scope, "scope");
  await pick("Permissions", p.name, "permission");
  await pick("Permissions levels", p.level, "level");
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
  secret: true,
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
    await fp.act(
      { kind: "fill", value: name },
      { role: "textbox", name: "Token name" },
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
    // The reveal has no main landmark (2026-10-05) and the token shows twice: read the body.
    const token = (
      await fp.page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).match(TOKEN)?.[1];
    if (!token) return fp.human("token page did not show a token");
    return { token };
  },
});
