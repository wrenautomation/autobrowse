import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { setupArgs } from "../src/app/cli-needs.js";
import {
  accountNeeds,
  allNeeds,
  commandFor,
  consentLoginOf,
  fileDone,
  formatNeeds,
  type NeedsContext,
  resolveNeeds,
  signupNeeds,
  siteNeeds,
} from "../src/app/needs.js";
import { SITE_LOGINS } from "../src/auth/sites.js";
import { gmail, meta, npm, perplexity, youtube } from "../src/sites/index.js";

const ctx = (env: Record<string, string>, extra: Partial<NeedsContext> = {}): NeedsContext => ({
  sites: [meta, youtube, gmail],
  logins: SITE_LOGINS,
  identities: [
    { address: "jin@gmail.com", at: "google", for: ["pays"] },
    { address: "w@wren.com", at: "google", for: ["default", "signup"] },
  ],
  credentials: memoryCredentials({ google: { username: "jin@gmail.com", password: "p" } }),
  env: (n) => env[n],
  workspaceDomain: null,
  phone: async () => ({ read: true, send: false }),
  desktop: null,
  ...extra,
});

describe("needs", () => {
  it("reopens a minted token's row inside the renew window, and its first line mints a new one", async () => {
    const day = 86_400_000;
    // Only in the shared store (SSM), not this process's env: still in hand.
    const row = (expiresInDays: number | null) =>
      siteNeeds(
        ctx(
          {},
          {
            sites: [npm],
            kept: async () => [
              {
                name: "NPM_TOKEN",
                updatedAt: null,
                expiresAt:
                  expiresInDays === null
                    ? null
                    : new Date(Date.now() + expiresInDays * day).toISOString(),
              },
            ],
          },
        ),
      ).find((r) => r.id === "token-npm");
    expect(await row(60)?.check?.()).toBe(true);
    expect(await row(null)?.check?.()).toBe(true);
    expect(await row(10)?.check?.()).toBe(false);
    expect(await row(-1)?.check?.()).toBe(false);
    expect(row(10)?.how[0]).toBe("autobrowse site setup npm token");
  });
  it("derives a site's login, keys and consent rows; google logins come from the accounts instead", async () => {
    expect(consentLoginOf(meta)).toBe("facebook");
    expect(consentLoginOf(youtube)).toBe("google");
    const rows = siteNeeds(ctx({}));
    expect(rows.map((r) => r.id)).toEqual([
      "login-facebook",
      "keys-meta",
      "consent-meta",
      "keys-youtube",
      "consent-youtube",
      "keys-gmail",
      "consent-gmail",
    ]);
    const keys = rows.find((r) => r.id === "keys-meta");
    expect(keys?.after).toBe("login-facebook");
    expect(keys?.how[0]).toBe("autobrowse site setup meta developer-app");
    expect(rows.find((r) => r.id === "consent-meta")?.after).toBe("keys-meta");
  });
  it("checks clear rows from what is in hand; a decision clears when the person says so", async () => {
    const c = ctx({
      GOOGLE_OAUTH_CLIENT_ID: "x",
      GOOGLE_OAUTH_CLIENT_SECRET: "y",
      YOUTUBE_REFRESH_TOKEN: "rt",
      GMAIL_REFRESH_TOKEN__JIN_GMAIL_COM: "rt",
    });
    const rows = await resolveNeeds(allNeeds(c), {
      "virtual-cards-vendor": { at: "2026-09-22T00:00:00Z", note: "privacy.com" },
    });
    const by = Object.fromEntries(rows.map((r) => [r.id, r.by]));
    expect(by["keys-youtube"]).toBe("check");
    expect(by["consent-youtube"]).toBe("check");
    expect(by["keys-meta"]).toBeNull();
    expect(by["login-google-jin"]).toBe("check");
    expect(by["inbox-jin"]).toBe("check");
    expect(by["login-google-w"]).toBeNull();
    expect(by["signup-inbox"]).toBeNull();
    expect(by["phone-forwarding"]).toBe("check");
    expect(by["phone-send"]).toBeNull();
    expect(by["virtual-cards-vendor"]).toBe("you");
    const text = formatNeeds(rows);
    expect(text).toContain("keys-meta (after login-facebook)");
    expect(text).not.toContain("virtual-cards-vendor");
    expect(text).not.toContain("rt");
    expect(formatNeeds(rows, { all: true })).toContain("✓ you said so: privacy.com");
    expect(formatNeeds(rows.map((r) => ({ ...r, done: true })))).toContain("nothing owed");
  });
  it("account rows: a credential and a readable inbox per google account", () => {
    const rows = accountNeeds(ctx({}));
    expect(rows.map((r) => r.id)).toEqual([
      "login-google-jin",
      "inbox-jin",
      "login-google-w",
      "inbox-w",
    ]);
    expect(rows.find((r) => r.id === "inbox-w")?.after).toBe("login-google-w");
  });
  it("sender mailboxes: one login row each, kept apart by domain; no inbox row (wren reads them)", () => {
    const rows = accountNeeds(
      ctx(
        {},
        {
          identities: [
            { address: "will@a.com", at: "google", for: ["sends"] },
            { address: "will@b.com", at: "google", for: ["sends"] },
          ],
        },
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(["login-google-will-a", "login-google-will-b"]);
  });
  it("done marks persist in a file", () => {
    const store = fileDone(join(mkdtempSync(join(tmpdir(), "needs-")), "done.json"));
    expect(store.read()).toEqual({});
    store.mark("x", "why");
    expect(store.read().x?.note).toBe("why");
    store.clear("x");
    expect(store.read()).toEqual({});
  });
  it("reads a setup command back into its parts", () => {
    expect(setupArgs("autobrowse site setup gmail consent --account w@wren.com")).toEqual({
      site: "gmail",
      step: "consent",
      account: "w@wren.com",
    });
    expect(setupArgs("autobrowse site setup meta developer-app")).toEqual({
      site: "meta",
      step: "developer-app",
      account: null,
    });
    expect(setupArgs("autobrowse creds paste x")).toBeNull();
    expect(setupArgs("autobrowse --owner acme site setup meta developer-app")).toEqual({
      site: "meta",
      step: "developer-app",
      account: null,
    });
  });
});

describe("an owner's needs", () => {
  const acme = { owner: "acme", envFile: "~/.config/autobrowse/owners/acme/.env" };

  it("keeps the owner's sites and accounts; the phone, this Mac, money and Wren's accounts stay the operator's", () => {
    const ids = (c: NeedsContext) => allNeeds(c).map((n) => n.id);
    const operator = ids(ctx({}, { sites: [meta, youtube, gmail, perplexity] }));
    const owner = ids(ctx({}, { sites: [meta, youtube, gmail, perplexity], ...acme }));
    for (const id of [
      "phone-forwarding",
      "mac-root",
      "anthropic-credits",
      "signup-x",
      "npm-account",
    ])
      expect(operator).toContain(id);
    expect(operator).toContain("token-perplexity");
    for (const id of [
      "keys-meta",
      "consent-youtube",
      "login-google-jin",
      "inbox-w",
      "signup-inbox",
    ])
      expect(owner).toContain(id);
    expect(owner).toContain("instantly-key");
    for (const id of [
      "phone-forwarding",
      "phone-send",
      "mac-root",
      "anthropic-credits",
      "virtual-cards-vendor",
      "youtube-consent-wren",
      "signup-x",
      "instagram-page-link",
      "npm-account",
      // The operator's tool: every owner uses the operator's key.
      "token-perplexity",
    ])
      expect(owner).not.toContain(id);
    expect(ids(ctx({}, { owner: "wren" }))).toEqual(ids(ctx({})));
  });

  it("every command runs as the owner and names the owner's env file", () => {
    const rows = allNeeds(ctx({}, acme));
    const lines = rows.flatMap((r) => r.how).filter((h) => h.includes("autobrowse "));
    expect(lines.length).toBeGreaterThan(5);
    for (const h of lines) expect(h).not.toMatch(/\bautobrowse (?!--owner acme )/);
    const keys = rows.find((r) => r.id === "keys-meta")?.how.join("\n") ?? "";
    expect(keys).toContain(`in ${acme.envFile}, then autobrowse --owner acme env push`);
    expect(setupArgs(rows.find((r) => r.id === "consent-gmail")?.how[0] ?? "")).toMatchObject({
      site: "gmail",
      step: "consent",
    });
    expect(commandFor("autobrowse creds paste x", "wren")).toBe("autobrowse creds paste x");
    expect(commandFor("autobrowse --owner acme creds paste x", "acme")).toBe(
      "autobrowse --owner acme creds paste x",
    );
  });
});

describe("signup needs", () => {
  it("asks for each Wren account until signup finished it, not just minted its credential", async () => {
    const c = ctx(
      {},
      {
        credentials: memoryCredentials({
          instagram: { username: "w@wren.com", password: "p", madeAt: "2026-09-22T00:00:00Z" },
          // William's own X: never Wren's, so it never closes signup-x.
          x: { username: "w@wren.com", password: "p", madeAt: "2026-09-22T00:00:00Z" },
        }),
      },
    );
    const rows = await resolveNeeds(signupNeeds(c), {});
    const open = rows.filter((r) => !r.done).map((r) => r.id);
    expect(open).toEqual(["signup-facebook", "signup-x", "signup-tiktok", "instagram-page-link"]);
    expect(rows.find((r) => r.id === "signup-instagram")?.by).toBe("check");
    const x = rows.find((r) => r.id === "signup-x");
    expect(x?.what).toMatch(/app-only/);
    expect(x?.how).toEqual([
      expect.stringMatching(/^in the x phone app: .*Continue with Google/),
      "autobrowse creds made x@wren",
    ]);
  });
});
