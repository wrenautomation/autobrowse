import { memoryCredentials } from "credvault";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/app/config.js";
import { googleTokens } from "../src/app/services.js";
import type { FlowRunner } from "../src/browser/flow.js";
import { googleOauthConsent } from "../src/browser/flows/oauth-consent.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { siteFacade } from "../src/sites/facade.js";
import { gmail } from "../src/sites/gmail.js";
import { accessTokens, accountEnv } from "../src/sites/oauth.js";
import { profileOf } from "../src/sites/wire.js";

function fakeFetch(
  answer: (req: { method: string; url: URL; headers: Headers; body: string }) => {
    status?: number;
    body?: unknown;
  },
) {
  const calls: { method: string; url: URL; headers: Headers; body: string }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const req = {
      method: init?.method ?? "GET",
      url: new URL(url),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(req);
    const a = answer(req);
    return new Response(JSON.stringify(a.body ?? {}), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch };
}

describe("gmail site: one consent per account", () => {
  it("names an account's token after the address", () => {
    expect(accountEnv("GMAIL_REFRESH_TOKEN")).toBe("GMAIL_REFRESH_TOKEN");
    expect(accountEnv("GMAIL_REFRESH_TOKEN", "will@williamjin.dev")).toBe(
      "GMAIL_REFRESH_TOKEN__WILL_WILLIAMJIN_DEV",
    );
  });

  it("mints the account's token from its own refresh token, cached apart from the site's", async () => {
    const api = fakeFetch(({ body }) => ({
      body: {
        access_token: `at-for-${new URLSearchParams(body).get("refresh_token")}`,
        expires_in: 3600,
      },
    }));
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
      GMAIL_REFRESH_TOKEN: "rt-own",
      GMAIL_REFRESH_TOKEN__WILL_WILLIAMJIN_DEV: "rt-will",
    };
    const spec = "oauth" in gmail.auth ? gmail.auth.oauth : (null as never);
    const tokens = accessTokens(httpClient({ fetch: api.fetch }), (n) => env[n]);
    expect(await tokens(spec)).toBe("at-for-rt-own");
    expect(await tokens(spec, "will@williamjin.dev")).toBe("at-for-rt-will");
    expect(await tokens(spec, "will@williamjin.dev")).toBe("at-for-rt-will");
    expect(api.calls.length).toBe(2);
    expect(await tokens(spec, "nobody@x.dev")).toBeNull();
  });

  it("a revoked refresh token is a terminal 409 naming the env, never the token", async () => {
    const api = fakeFetch(() => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    }));
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
      GMAIL_REFRESH_TOKEN: "rt-own",
    };
    const spec = "oauth" in gmail.auth ? gmail.auth.oauth : (null as never);
    const err = await accessTokens(
      httpClient({ fetch: api.fetch }),
      (n) => env[n],
    )(spec).catch((e) => e);
    expect(err).toMatchObject({ name: "SiteError", status: 409 });
    expect(err.message).toContain("GMAIL_REFRESH_TOKEN");
    expect(err.message).not.toContain("rt-own");
  });

  it("googleTokens acts as a consented account through its token for Gmail, the service account for the rest", async () => {
    const api = fakeFetch(() => ({ body: { access_token: "at-will", expires_in: 3600 } }));
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
      GMAIL_REFRESH_TOKEN__WILL_WILLIAMJIN_DEV: "rt-will",
    };
    const tokenFor = googleTokens(
      loadSettings({ RESTATE_INGRESS_URL: "http://127.0.0.1:8080" }),
      (n) => env[n],
      httpClient({ fetch: api.fetch }),
    );
    const gmail = "https://www.googleapis.com/auth/gmail.readonly";
    expect(await tokenFor("will@williamjin.dev", [gmail])()).toBe("at-will");
    // The consent grants Gmail only: an admin scope on the same account goes to the service account.
    expect(() =>
      tokenFor("will@williamjin.dev", ["https://www.googleapis.com/auth/admin.directory.user"]),
    ).toThrow(/GOOGLE_SERVICE_ACCOUNT/);
    // No key set: a Workspace subject still goes to the service account, which is not there.
    expect(() => tokenFor("william@wrenautomation.com", [gmail])).toThrow(/GOOGLE_SERVICE_ACCOUNT/);
  });

  it("the profile for an account is the <site>@<label> credential with that username", async () => {
    const creds = memoryCredentials({
      google: { username: "jin@gmail.com", password: "p" },
      "google@will": { username: "Will@WilliamJin.dev", password: "p" },
    });
    expect(await profileOf(creds, "google", "jin@gmail.com")).toBe("google");
    expect(await profileOf(creds, "google", "will@williamjin.dev")).toBe("google@will");
    expect(await profileOf(creds, "google", "other@x.dev")).toBeNull();
  });

  it("a handle login is found by the inbox its codes go to, when only one has it", async () => {
    const creds = memoryCredentials({
      x: { username: "jin@gmail.com", password: "p" },
      "x@wren": { username: "wren_automation", password: "p", codesInbox: "william@wren.co" },
    });
    expect(await profileOf(creds, "x", "william@wren.co")).toBe("x@wren");
    const two = memoryCredentials({
      "x@a": { username: "a", password: "p", codesInbox: "ops@wren.co" },
      "x@b": { username: "b", password: "p", codesInbox: "ops@wren.co" },
    });
    expect(await profileOf(two, "x", "ops@wren.co")).toBeNull();
  });

  it("a consent without --account is kept under whoever consented, too", async () => {
    const port = 9414;
    const api = fakeFetch(({ url }) =>
      url.pathname.endsWith("/profile")
        ? { body: { emailAddress: "jin@gmail.com" } }
        : { body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } },
    );
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
    };
    const sink = memorySink();
    const runner: FlowRunner = {
      async run(_flow, input) {
        const u = new URL((input as { url: string }).url);
        await fetch(
          `http://127.0.0.1:${port}/oauth/callback?code=c&state=${u.searchParams.get("state")}`,
        );
        return { landed: "" } as never;
      },
    };
    const sites = siteFacade([gmail], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink,
      runner,
      flow: (name) => (name === "google/oauth-consent" ? googleOauthConsent : null),
      oauthPort: port,
    });
    await expect(sites.setup("gmail", "consent")).resolves.toEqual({
      made: ["GMAIL_REFRESH_TOKEN", "GMAIL_REFRESH_TOKEN__JIN_GMAIL_COM"],
    });
    expect(Object.keys(sink.values)).toEqual([
      "GMAIL_REFRESH_TOKEN",
      "GMAIL_REFRESH_TOKEN__JIN_GMAIL_COM",
    ]);
  });

  it("consent --account runs the walk in that profile and keeps the token under the account's name", async () => {
    const port = 9419;
    const api = fakeFetch(({ url }) =>
      url.pathname.endsWith("/profile")
        ? { body: { emailAddress: "Will@williamjin.dev" } }
        : { body: { access_token: "at", refresh_token: "rt-will", expires_in: 3600 } },
    );
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
    };
    const sink = memorySink();
    const ran: { site: string; account?: string }[] = [];
    const runner: FlowRunner = {
      async run(flow, input) {
        const { url, account } = input as { url: string; account?: string };
        ran.push({ site: flow.site, ...(account ? { account } : {}) });
        const u = new URL(url);
        await fetch(
          `http://127.0.0.1:${port}/oauth/callback?code=c&state=${u.searchParams.get("state")}`,
        );
        return { landed: "" } as never;
      },
    };
    const sites = siteFacade([gmail], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink,
      runner,
      flow: (name) => (name === "google/oauth-consent" ? googleOauthConsent : null),
      oauthPort: port,
      profileFor: async (site, account) =>
        account === "will@williamjin.dev" ? `${site}@will` : null,
    });
    await expect(sites.setup("gmail", "consent", "will@williamjin.dev")).resolves.toEqual({
      made: ["GMAIL_REFRESH_TOKEN__WILL_WILLIAMJIN_DEV"],
    });
    expect(ran).toEqual([{ site: "google@will", account: "will@williamjin.dev" }]);
    // An account with no credential of its own never consents in the default profile, as whoever that is.
    await expect(sites.setup("gmail", "consent", "stranger@x.dev")).rejects.toMatchObject({
      status: 409,
    });
    expect(ran).toHaveLength(1);
    expect(sink.values).toEqual({ GMAIL_REFRESH_TOKEN__WILL_WILLIAMJIN_DEV: "rt-will" });
    // A call as that account carries its token; the site's own has none yet.
    env.GMAIL_REFRESH_TOKEN__WILL_WILLIAMJIN_DEV = "rt-will";
    const seen: string[] = [];
    const reads = fakeFetch(({ url, headers, body }) => {
      if (url.host === "oauth2.googleapis.com")
        return { body: { access_token: "at-will", expires_in: 3600 } };
      seen.push(`${url.pathname} ${headers.get("authorization")}`);
      return { body: { messages: [], _: body } };
    });
    const sites2 = siteFacade([gmail], {
      http: httpClient({ fetch: reads.fetch }),
      env: (n) => env[n],
      sink,
      runner,
      flow: () => null,
    });
    await sites2.call(
      "gmail",
      "GET",
      "/gmail/v1/users/me/messages",
      { q: "after:1" },
      "will@williamjin.dev",
    );
    expect(seen).toEqual(["/gmail/v1/users/me/messages Bearer at-will"]);
    await expect(
      sites2.call("gmail", "GET", "/gmail/v1/users/me/messages", {}),
    ).rejects.toMatchObject({ status: 501 });
  });
});

describe("gmail site: push", () => {
  it("watch posts the topic as the account and refuses a topic that isn't one", async () => {
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
      GMAIL_REFRESH_TOKEN: "rt-own",
    };
    const api = fakeFetch(({ url }) =>
      url.host === "oauth2.googleapis.com"
        ? { body: { access_token: "at-own", expires_in: 3600 } }
        : { body: { historyId: "7", expiration: "1700000000000" } },
    );
    const sites = siteFacade([gmail], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink: memorySink(),
      runner: { run: async () => ({ landed: "" }) as never },
      flow: () => null,
    });
    const topicName = "projects/p/topics/gmail-push";
    await expect(
      sites.call("gmail", "POST", "/gmail/v1/users/me/watch", { topicName, labelIds: ["INBOX"] }),
    ).resolves.toEqual({ historyId: "7", expiration: "1700000000000" });
    const sent = api.calls.find((c) => c.url.pathname === "/gmail/v1/users/me/watch");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe("Bearer at-own");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ topicName, labelIds: ["INBOX"] });
    await expect(
      sites.call("gmail", "POST", "/gmail/v1/users/me/watch", { topicName: "gmail-push" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("messageText", () => {
  it("keeps link targets of an HTML-only mail and drops its CSS", async () => {
    const { messageText } = await import("../src/clients/gmail.js");
    const html =
      '<style>.a{b:c}</style><p>Hi</p><a class="x" href="https://t.test/c/1?a=1&amp;b=2">Confirm</a>';
    const text = messageText({
      payload: { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } },
    } as never);
    expect(text.trim()).toBe("Hi https://t.test/c/1?a=1&b=2 Confirm");
  });
});
