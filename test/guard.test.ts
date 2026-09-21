import { describe, expect, it } from "vitest";
import { noCodes } from "../src/auth/codes.js";
import { memoryCredentials } from "../src/auth/credentials.js";
import { guardedPage, memoryAudit, registrable, SecretLeak } from "../src/auth/guard.js";
import { passwordDomains, SITE_LOGINS, signInContext } from "../src/auth/index.js";
import { fakePage } from "./auth-fakes.js";

const cred = { username: "u", password: "hunter2!", recoveryCodes: [], passkeys: [] };

describe("passwords bound to their origins", () => {
  it("names the domains a credential's password may land on", () => {
    expect(passwordDomains(SITE_LOGINS, "google", cred)).toEqual(["google.com"]);
    expect(passwordDomains(SITE_LOGINS, "google@will", cred)).toEqual(["google.com"]);
    expect(passwordDomains(SITE_LOGINS, "microsoft", cred)).toEqual([
      "live.com",
      "microsoftonline.com",
      "microsoft.com",
    ]);
    expect(passwordDomains(SITE_LOGINS, "linkedin", cred)).toEqual(["linkedin.com"]);
    expect(
      passwordDomains(SITE_LOGINS, "new-tool", { url: "https://app.new-tool.io/login" }),
    ).toEqual(["new-tool.io"]);
    expect(passwordDomains(SITE_LOGINS, "nobody", {})).toEqual([]);
    expect(registrable("www.instagram.com")).toBe("instagram.com");
  });

  it("types the password on its own site, refuses it elsewhere, and records both", async () => {
    const audit = memoryAudit();
    let url = "https://www.instagram.com/accounts/login/?next=%2Ftoken%3Dabc";
    const { fp, acts } = fakePage({ text: [""], present: () => true, url: () => url });
    const page = guardedPage(fp, {
      name: "instagram",
      cred,
      domains: ["instagram.com"],
      site: "instagram",
      by: "login",
      audit,
    });
    await page.act({ kind: "fill", value: "hunter2!" }, { role: "textbox" }, { goal: "pw" });
    await page.act({ kind: "fill", value: "not a secret" }, { role: "textbox" }, { goal: "x" });
    url = "https://instagram-login.evil.example/";
    await expect(
      page.act({ kind: "fill", value: "hunter2!" }, { role: "textbox" }, { goal: "pw" }),
    ).rejects.toBeInstanceOf(SecretLeak);
    expect(acts.length).toBe(2);
    expect(audit.uses.map((u) => `${u.credential} ${u.field} ${u.allowed} ${u.url}`)).toEqual([
      "instagram password true https://www.instagram.com/accounts/login/",
      "instagram password false https://instagram-login.evil.example/",
    ]);
    expect(JSON.stringify(audit.uses)).not.toContain("hunter2");
  });

  it("with no domains known, the host must carry the name", async () => {
    let url = "https://app.instantly.ai/login";
    const { fp, acts } = fakePage({ text: [""], present: () => true, url: () => url });
    const page = guardedPage(fp, {
      name: "instantly",
      cred,
      domains: [],
      fallback: "instantly",
      site: "instantly",
      by: "login",
    });
    await page.act({ kind: "fill", value: "hunter2!" }, { role: "textbox" }, { goal: "pw" });
    url = "https://example.com/";
    await expect(
      page.act({ kind: "fill", value: "hunter2!" }, { role: "textbox" }, { goal: "pw" }),
    ).rejects.toThrow(/not one of its origins/);
    expect(acts.length).toBe(1);
  });

  it("a sign-in context binds the provider's password to the provider's origins", async () => {
    const audit = memoryAudit();
    let url = "https://accounts.google.com/v3/signin/challenge/pwd";
    const { fp } = fakePage({ text: [""], present: () => true, url: () => url });
    const creds = memoryCredentials({
      cloudflare: { username: "u", via: "google" },
      google: { username: "g@gmail.com", password: "gpw-secret" },
    });
    const ctx = signInContext({
      fp,
      site: "cloudflare",
      cred: (await creds.get("cloudflare")) as never,
      credentials: creds,
      codes: noCodes,
      domainsFor: (name) => passwordDomains(SITE_LOGINS, name, {}),
      audit,
    });
    const google = ctx.as(await ctx.credFor("google"));
    await google.fp.act({ kind: "fill", value: "gpw-secret" }, { role: "textbox" }, { goal: "pw" });
    url = "https://dash.cloudflare.com/login";
    await expect(
      google.fp.act({ kind: "fill", value: "gpw-secret" }, { role: "textbox" }, { goal: "pw" }),
    ).rejects.toBeInstanceOf(SecretLeak);
    expect(audit.uses.map((u) => `${u.credential}@${u.site} ${u.allowed}`)).toEqual([
      "google@cloudflare true",
      "google@cloudflare false",
    ]);
  });
});
