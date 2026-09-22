import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { formatReadiness, readiness } from "../src/app/cli-accounts.js";
import {
  assignPurpose,
  fileIdentities,
  formatIdentities,
  identityAt,
  identityFor,
  parseIdentities,
  withIdentity,
  withoutIdentity,
} from "../src/auth/identities.js";
import { signupInbox } from "../src/auth/signup.js";
import { googleOauthConsent } from "../src/browser/flows/oauth-consent.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { siteFacade } from "../src/sites/facade.js";
import { meta, youtube } from "../src/sites/index.js";
import { accountForSite, consentProviderOf } from "../src/sites/wire.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const jin = { address: "jin@gmail.com", at: "google" as const, for: ["pays"] };
const wren = { address: "w@wren.com", at: "google" as const, for: ["default", "signup"] };
const ms = { address: "w@outlook.com", at: "microsoft" as const, for: ["default"] };

describe("accounts policy", () => {
  it("a purpose names its account, else the default; a provider narrows it", () => {
    const all = [jin, wren, ms];
    expect(identityFor(all, "pays")?.address).toBe("jin@gmail.com");
    expect(identityFor(all, "dev")?.address).toBe("w@wren.com");
    expect(identityFor([jin], "dev")).toBeNull();
    expect(identityAt(all, "microsoft", "pays")?.address).toBe("w@outlook.com");
    expect(identityAt(all, "google", "signup")?.address).toBe("w@wren.com");
  });
  it("round-trips the env form, with the provider only when it is not google", () => {
    const text = formatIdentities([jin, wren, ms]);
    expect(text).toBe(
      "jin@gmail.com=pays;w@wren.com=default,signup;w@outlook.com@microsoft=default",
    );
    expect(parseIdentities(text)).toEqual([jin, wren, ms]);
    expect(parseIdentities(" ")).toEqual([]);
  });
  it("a purpose moves between accounts; add replaces; remove forgets", () => {
    let all = withIdentity([jin, wren], { ...jin, for: ["pays", "signup"] });
    expect(all.find((i) => i.address === wren.address)?.for).toEqual(["default"]);
    expect(all.find((i) => i.address === jin.address)?.for).toEqual(["pays", "signup"]);
    all = assignPurpose(all, "signup", "w@wren.com");
    expect(all.find((i) => i.address === jin.address)?.for).toEqual(["pays"]);
    expect(() => assignPurpose(all, "x", "nobody@x.com")).toThrow(/accounts add/);
    expect(withoutIdentity(all, "JIN@gmail.com").map((i) => i.address)).toEqual(["w@wren.com"]);
  });
  it("the file store keeps addresses and purposes, never anything else", async () => {
    const store = fileIdentities(join(mkdtempSync(join(tmpdir(), "ids-")), "accounts.json"));
    expect(await store.list()).toEqual([]);
    await store.save([jin]);
    expect(await store.list()).toEqual([jin]);
  });
  it("a site's account is the one for its purpose at its consent's provider; other consents get none", async () => {
    expect(consentProviderOf(youtube)).toBe("google");
    expect(consentProviderOf(meta)).toBeNull();
    expect(await accountForSite([jin, wren], youtube)).toBe("w@wren.com");
    expect(await accountForSite([jin, wren], { ...youtube, purpose: "pays" })).toBe(
      "jin@gmail.com",
    );
    expect(await accountForSite([jin, wren], meta)).toBeNull();
    expect(await accountForSite([], youtube)).toBeNull();
    const step = youtube.setup.find((s) => s.name === "consent");
    expect(
      await accountForSite([jin, wren], youtube, { ...(step as never), purpose: "pays" }),
    ).toBe("jin@gmail.com");
  });
  it("a signup inbox is readable when it consented or is in the Workspace", () => {
    const env = { GMAIL_REFRESH_TOKEN__JIN_GMAIL_COM: "rt" };
    const o = { env: (n: string) => env[n as keyof typeof env], workspaceDomain: "wren.com" };
    expect(signupInbox("jin@gmail.com", o)).toBe(true);
    expect(signupInbox("w@wren.com", o)).toBe(true);
    expect(signupInbox("will@dev.io", o)).toBe(false);
  });
});

describe("facade with the policy", () => {
  it("a call with no account uses the policy's token, falling back to the site's own", async () => {
    const api = fakeFetch(({ url, body, headers }) => {
      if (url.host === "oauth2.googleapis.com") {
        return {
          body: {
            access_token: body?.includes("refresh_token=rt-wren") ? "at-wren" : "at-own",
            expires_in: 3600,
          },
        };
      }
      return { body: { bearer: headers.get("authorization") } };
    });
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
      YOUTUBE_REFRESH_TOKEN: "rt-own",
    };
    const sites = siteFacade([youtube], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
      accountFor: async (s, step) => accountForSite([jin, wren], s, step),
    });
    const q = { part: "statistics", id: "v1" };
    expect(await sites.call("youtube", "GET", "/youtube/v3/videos", q)).toEqual({
      bearer: "Bearer at-own",
    });
    env.YOUTUBE_REFRESH_TOKEN__W_WREN_COM = "rt-wren";
    expect(await sites.call("youtube", "GET", "/youtube/v3/videos", q)).toEqual({
      bearer: "Bearer at-wren",
    });
    // Named by the caller: no fallback.
    await expect(
      sites.call("youtube", "GET", "/youtube/v3/videos", q, "nobody@x.com"),
    ).rejects.toMatchObject({ status: 501 });
  });
  it("a consent with no account runs as the policy's and keeps the token under both names", async () => {
    const port = 9413;
    const api = fakeFetch(() => ({
      body: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
    }));
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
    };
    const sink = memorySink();
    const browser = fakeBrowser([]);
    const profiles: string[] = [];
    browser.on(googleOauthConsent, async ({ url }) => {
      const u = new URL(url);
      await fetch(
        `http://127.0.0.1:${port}/oauth/callback?code=c&state=${u.searchParams.get("state")}`,
      );
      return { landed: "" };
    });
    const sites = siteFacade([youtube], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink,
      runner: browser,
      flow: (name) => (name === "google/oauth-consent" ? googleOauthConsent : null),
      oauthPort: port,
      accountFor: async (s, step) => accountForSite([jin, wren], s, step),
      profileFor: async (site, account) => {
        profiles.push(`${site} ${account}`);
        return "google@wren";
      },
    });
    await expect(sites.setup("youtube", "consent")).resolves.toEqual({
      made: ["YOUTUBE_REFRESH_TOKEN", "YOUTUBE_REFRESH_TOKEN__W_WREN_COM"],
    });
    expect(profiles).toEqual(["google w@wren.com"]);
  });
});

describe("accounts readiness", () => {
  it("says what each account has, never a value", async () => {
    const credentials = memoryCredentials({
      google: { username: "jin@gmail.com", password: "p" },
      "google@wren": { username: "w@wren.com", password: "p" },
    });
    const env: Record<string, string> = {
      GMAIL_REFRESH_TOKEN__JIN_GMAIL_COM: "rt",
      YOUTUBE_REFRESH_TOKEN__JIN_GMAIL_COM: "rt",
      YOUTUBE_REFRESH_TOKEN: "rt",
    };
    const deps = {
      identities: { list: async () => [jin, wren, ms], save: async () => {} },
      credentials,
      env: (n: string) => env[n],
      envNames: () => Object.keys(env),
      workspaceDomain: "wren.com",
      push: async () => {},
    };
    const rows = await Promise.all([jin, wren, ms].map((i) => readiness(deps, i)));
    expect(rows).toEqual([
      {
        address: "jin@gmail.com",
        at: "google",
        for: ["pays"],
        credential: "google",
        inbox: "consented",
        tokens: ["GMAIL_REFRESH_TOKEN", "YOUTUBE_REFRESH_TOKEN"],
      },
      {
        address: "w@wren.com",
        at: "google",
        for: ["default", "signup"],
        credential: "google@wren",
        inbox: "service account",
        tokens: [],
      },
      {
        address: "w@outlook.com",
        at: "microsoft",
        for: ["default"],
        credential: null,
        inbox: null,
        tokens: [],
      },
    ]);
    const text = formatReadiness(rows);
    expect(text).not.toContain("rt");
    expect(text).toContain("credential google@wren");
    expect(formatReadiness([])).toContain("accounts add");
  });
});
