import {
  CanaryTripped,
  canaryCredential,
  canaryStore,
  memoryAudit,
  memoryCredentials,
  memorySecrets,
  trackingSecrets,
} from "credvault";
import { describe, expect, it } from "vitest";
import { noCodes } from "../src/auth/codes.js";
import { boundRunner, guardedPage, registrable, SecretLeak } from "../src/auth/guard.js";
import { passwordDomains, SITE_LOGINS, signInContext, siteAllowsHost } from "../src/auth/index.js";
import { defineFlow, type FlowRunner } from "../src/browser/flow.js";
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

  it("a compiled run's secrets go only to the flow's site, under the flow's name", async () => {
    const audit = memoryAudit();
    let url = "https://app.instantly.ai/settings/api";
    const { fp, acts } = fakePage({ text: [""], present: () => true, url: () => url });
    const secrets = trackingSecrets(memorySecrets({ apiKey: "sk-live-1234" }));
    const runner: FlowRunner = { run: (flow, input) => flow.run(fp, input) };
    const bound = boundRunner(runner, {
      secrets,
      allow: (site, host) => siteAllowsHost(SITE_LOGINS, site, host),
      audit,
    });
    const flow = defineFlow<{ apiKey: string }, void>({
      site: "instantly",
      name: "set-key",
      async run(page, input) {
        await page.act({ kind: "fill", value: "will" }, { role: "textbox" }, { goal: "name" });
        await page.act({ kind: "fill", value: input.apiKey }, { role: "textbox" }, { goal: "key" });
      },
    });
    const apiKey = await secrets.get("apiKey");
    await bound.run(flow, { apiKey });
    expect(acts.length).toBe(2);
    url = "https://instantly-help.evil.example/";
    await expect(bound.run(flow, { apiKey })).rejects.toThrow(/apiKey's value is not typed on/);
    expect(acts.length).toBe(3);
    expect(audit.uses.map((u) => `${u.credential} ${u.field} ${u.by} ${u.allowed}`)).toEqual([
      "apiKey secret instantly/set-key true",
      "apiKey secret instantly/set-key false",
    ]);
    expect(JSON.stringify(audit.uses)).not.toContain("sk-live");
  });

  it("siteAllowsHost: the site's word, its login origins, nothing else", () => {
    expect(siteAllowsHost(SITE_LOGINS, "instantly", "app.instantly.ai")).toBe(true);
    expect(siteAllowsHost(SITE_LOGINS, "google", "accounts.google.com")).toBe(true);
    expect(siteAllowsHost(SITE_LOGINS, "microsoft", "login.microsoftonline.com")).toBe(true);
    expect(siteAllowsHost(SITE_LOGINS, "x", "api.x.com")).toBe(true);
    expect(siteAllowsHost(SITE_LOGINS, "x@wren", "twitter.com")).toBe(true);
    expect(siteAllowsHost(SITE_LOGINS, "google", "google-login.evil.example")).toBe(false);
    expect(siteAllowsHost(SITE_LOGINS, "instantly", "instantly.evil.example")).toBe(false);
    expect(siteAllowsHost(SITE_LOGINS, "cloudflare", "accounts.google.com")).toBe(false);
    expect(siteAllowsHost(SITE_LOGINS, "nobody", "example.com")).toBe(false);
  });

  it("registrable follows the public suffix list, private suffixes included", () => {
    expect(registrable("www.foo.co.uk")).toBe("foo.co.uk");
    expect(registrable("evil.github.io")).toBe("evil.github.io");
    expect(registrable("mx-ha03.web.de")).toBe("web.de");
    expect(registrable("app.scratch.test")).toBe("scratch.test");
    expect(registrable("localhost")).toBe("localhost");
    expect(registrable("127.0.0.1")).toBe("127.0.0.1");
    expect(passwordDomains(SITE_LOGINS, "shop", { url: "https://www.foo.co.uk/login" })).toEqual([
      "foo.co.uk",
    ]);
    // A user page on a shared host is not the site that owns the suffix.
    expect(siteAllowsHost(SITE_LOGINS, "github", "evil.github.io")).toBe(false);
    expect(siteAllowsHost(SITE_LOGINS, "github", "github.com")).toBe(true);
  });

  it("the no-domains fallback is the host's registrable name, not a substring", async () => {
    let url = "https://instantly-help.evil.example/login";
    const { fp, acts } = fakePage({ text: [""], present: () => true, url: () => url });
    const page = guardedPage(fp, {
      name: "instantly",
      cred,
      domains: [],
      fallback: "instantly",
      site: "instantly",
      by: "login",
    });
    await expect(
      page.act({ kind: "fill", value: "hunter2!" }, { role: "textbox" }, { goal: "pw" }),
    ).rejects.toBeInstanceOf(SecretLeak);
    url = "https://instantly.evil.example/login";
    await expect(
      page.act({ kind: "fill", value: "hunter2!" }, { role: "textbox" }, { goal: "pw" }),
    ).rejects.toBeInstanceOf(SecretLeak);
    url = "https://app.instantly.ai/login";
    await page.act({ kind: "fill", value: "hunter2!" }, { role: "textbox" }, { goal: "pw" });
    expect(acts.length).toBe(1);
  });

  it("a canary: reading it is the alarm, and its password types nowhere", async () => {
    const audit = memoryAudit();
    const told: string[] = [];
    const inner = memoryCredentials({ google: { username: "g", password: "real" } });
    const canary = canaryCredential("billing@wrenautomation.com");
    await inner.put("stripe", canary);
    const store = canaryStore(inner, {
      audit,
      by: "login",
      notify: async (title) => {
        told.push(title);
      },
    });
    expect((await store.get("google"))?.username).toBe("g");
    expect((await store.list()).sort()).toEqual(["google", "stripe"]);
    await expect(store.get("stripe")).rejects.toBeInstanceOf(CanaryTripped);
    expect(told).toEqual(["canary tripped: stripe"]);
    expect(audit.uses.map((u) => `${u.credential} ${u.by} ${u.allowed}`)).toEqual([
      "stripe login (canary) false",
    ]);
    expect(JSON.stringify(audit.uses)).not.toContain(canary.password as string);
    // Even a copy that reached a page is refused on the canary's own host.
    const { fp, acts } = fakePage({
      text: [""],
      present: () => true,
      url: () => "https://dashboard.stripe.com/login",
    });
    const page = guardedPage(fp, {
      name: "stripe",
      cred: (await inner.get("stripe")) as never,
      domains: ["stripe.com"],
      site: "stripe",
      by: "login",
    });
    await expect(
      page.act(
        { kind: "fill", value: canary.password as string },
        { role: "textbox" },
        { goal: "pw" },
      ),
    ).rejects.toBeInstanceOf(SecretLeak);
    expect(acts.length).toBe(0);
  });
});
