import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFlow } from "../src/browser/flow.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import {
  accessTokens,
  linkedin,
  matchPath,
  route,
  runConsent,
  type SiteApi,
  SiteError,
  siteFacade,
  youtube,
} from "../src/sites/index.js";
import { fakeBrowser } from "./fakes.js";

/** A fetch that records requests and answers from a table by method + path. */
function fakeFetch(
  answer: (req: { method: string; url: URL; headers: Headers; body: string }) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  const calls: { method: string; url: URL; headers: Headers; body: string }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const req = {
      method: init?.method ?? "GET",
      url: new URL(url),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : init?.body ? "<bytes>" : "",
    };
    calls.push(req);
    const a = answer(req);
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json", ...(a.headers ?? {}) },
    });
  };
  return { calls, fetch };
}

const whoami = defineFlow<Record<string, never>, { sub: string }>({
  site: "linkedin",
  name: "whoami",
  async run() {
    return { sub: "browser-sub" };
  },
});
const createPost = defineFlow<{ text: string; visibility: string }, { id: string }>({
  site: "linkedin",
  name: "create-post",
  async run() {
    return { id: "urn:li:share:9" };
  },
});
const consent = defineFlow<{ url: string }, void>({
  site: "google",
  name: "oauth-consent",
  async run() {},
});

const person = "urn:li:person:abc";

describe("site facade", () => {
  it("matches official paths with {params}", () => {
    expect(
      matchPath(
        "/rest/socialActions/{urn}/comments",
        "/rest/socialActions/urn:li:share:1/comments",
      ),
    ).toEqual({
      urn: "urn:li:share:1",
    });
    expect(matchPath("/rest/posts", "/rest/posts?q=author")).toEqual({});
    expect(matchPath("/rest/posts", "/rest/posts/x")).toBeNull();
    expect(matchPath("/youtube/v3/{resource}", "/youtube/v3/videos")).toEqual({
      resource: "videos",
    });
  });

  it("answers through the API with a token, in the official shape", async () => {
    const api = fakeFetch(({ method, url, headers }) => {
      expect(headers.get("authorization")).toBe("Bearer tok");
      if (url.pathname === "/v2/userinfo") return { body: { sub: "abc" } };
      if (method === "POST" && url.pathname === "/rest/posts") {
        expect(headers.get("linkedin-version")).toMatch(/^\d{6}$/);
        return { status: 201, headers: { "x-restli-id": "urn:li:share:1" } };
      }
      if (url.pathname === "/rest/posts") {
        expect(url.searchParams.get("author")).toBe(person);
        expect(url.searchParams.get("count")).toBe("5");
        return { body: { elements: [] } };
      }
      return { status: 404 };
    });
    const browser = fakeBrowser([]);
    const env: Record<string, string> = { LINKEDIN_ACCESS_TOKEN: "tok" };
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink: memorySink(),
      runner: browser,
      flow: () => null,
    });
    expect(await sites.call("linkedin", "GET", "/v2/userinfo", {})).toEqual({ sub: "abc" });
    expect(
      await sites.call("linkedin", "POST", "/rest/posts", { author: person, commentary: "hi" }),
    ).toEqual({ id: "urn:li:share:1" });
    expect(JSON.parse(api.calls[1]?.body ?? "{}")).toMatchObject({
      author: person,
      commentary: "hi",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
      distribution: { feedDistribution: "MAIN_FEED" },
    });
    expect(
      await sites.call("linkedin", "GET", "/rest/posts", { author: person, count: "5" }),
    ).toEqual({
      elements: [],
    });
    const row = await sites.status("linkedin");
    expect(row.authed).toBe(true);
    expect(row.routes.find((r) => r.path === "/rest/posts" && r.method === "POST")).toMatchObject({
      via: "api",
      irreversible: true,
    });
  });

  it("falls to the browser leg without a token, says which flows are unrecorded, and validates like the API", async () => {
    const browser = fakeBrowser([]);
    browser.on(whoami, async () => ({ sub: "browser-sub" }));
    browser.on(createPost, async (i) => {
      expect(i).toEqual({ text: "hello", visibility: "PUBLIC" });
      return { id: "urn:li:share:9" };
    });
    const flows: Record<string, typeof whoami | typeof createPost> = {
      "linkedin/whoami": whoami,
      "linkedin/create-post": createPost,
    };
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => (flows[n] as never) ?? null,
    });
    expect(await sites.call("linkedin", "GET", "/v2/userinfo", {})).toEqual({ sub: "browser-sub" });
    expect(
      await sites.call("linkedin", "POST", "/rest/posts", { author: person, commentary: "hello" }),
    ).toEqual({
      id: "urn:li:share:9",
    });
    await expect(
      sites.call("linkedin", "POST", "/rest/posts", { commentary: "x" }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      sites.call("linkedin", "GET", "/rest/socialActions/urn:li:share:1", {}),
    ).rejects.toMatchObject({
      status: 501,
      message: expect.stringMatching(/linkedin\/post-stats not recorded/),
    });
    await expect(sites.call("linkedin", "DELETE", "/rest/posts", {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(sites.call("nope", "GET", "/", {})).rejects.toBeInstanceOf(SiteError);
    const row = await sites.status("linkedin");
    expect(row.authed).toBe(false);
    expect(row.routes.find((r) => r.path === "/v2/userinfo")?.via).toBe("browser");
    expect(row.routes.find((r) => r.path === "/rest/socialActions/{urn}")).toMatchObject({
      via: "none",
      missing: "flow linkedin/post-stats not recorded",
    });
    // /rest/posts/{urn} has no browser leg: without a token it says so.
    expect(row.routes.find((r) => r.path === "/rest/posts/{urn}")).toMatchObject({ via: "none" });
    expect(row.setup.map((s) => [s.name, s.done, s.blockedOn, s.unrecorded])).toEqual([
      ["developer-app", false, [], "linkedin/developer-app"],
      [
        "consent",
        false,
        ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
        "linkedin/oauth-consent",
      ],
    ]);
  });

  it("mints a YouTube access token from the refresh token once, then reads with it", async () => {
    let mints = 0;
    const api = fakeFetch(({ url, body, headers }) => {
      if (url.host === "oauth2.googleapis.com") {
        mints++;
        expect(body).toContain("grant_type=refresh_token");
        expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
        return { body: { access_token: "at", expires_in: 3600 } };
      }
      expect(headers.get("authorization")).toBe("Bearer at");
      expect(url.pathname).toBe("/youtube/v3/videos");
      expect(url.searchParams.get("part")).toBe("statistics");
      return { body: { items: [{ id: "v1", statistics: { viewCount: "3" } }] } };
    });
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
      YOUTUBE_REFRESH_TOKEN: "rt",
    };
    const sites = siteFacade([youtube], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
    });
    const q = { part: "statistics", id: "v1" };
    expect(await sites.call("youtube", "GET", "/youtube/v3/videos", q)).toMatchObject({
      items: [{ id: "v1" }],
    });
    await sites.call("youtube", "GET", "/youtube/v3/videos", q);
    expect(mints).toBe(1);
    const row = await sites.status("youtube");
    expect(row.authed).toBe(true);
    expect(row.routes.find((r) => r.path === "/studio/communityPosts")).toMatchObject({
      via: "none",
      missing: "flow youtube/community-post not recorded",
    });
  });

  it("access tokens fall back to a kept access token when there is no refresh token", async () => {
    const env: Record<string, string> = { LINKEDIN_ACCESS_TOKEN: "kept" };
    const mint = accessTokens(
      httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      (n) => env[n],
    );
    expect(await mint(linkedin.auth as never)).toBeNull();
    const spec = "oauth" in linkedin.auth ? linkedin.auth.oauth : null;
    expect(await mint(spec as never)).toBe("kept");
  });

  it("runs a consent: loopback redirect, code exchange, tokens kept through setup", async () => {
    const port = 9411;
    const api = fakeFetch(({ url, body }) => {
      expect(url.host).toBe("oauth2.googleapis.com");
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain("code=the-code");
      return { body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } };
    });
    const browser = fakeBrowser([]);
    browser.on(consent, async ({ url }) => {
      const u = new URL(url);
      expect(u.searchParams.get("client_id")).toBe("cid");
      expect(u.searchParams.get("access_type")).toBe("offline");
      expect(u.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/oauth/callback`);
      // The consent page redirects to loopback with the code and our state.
      await fetch(
        `http://127.0.0.1:${port}/oauth/callback?code=the-code&state=${u.searchParams.get("state")}`,
      );
    });
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
    };
    const sink = memorySink();
    const sites = siteFacade([youtube], {
      http: httpClient({ fetch: api.fetch }),
      env: (n) => env[n],
      sink,
      runner: browser,
      flow: (n) => (n === "google/oauth-consent" ? (consent as never) : null),
      oauthPort: port,
    });
    await expect(sites.setup("youtube", "consent")).resolves.toEqual({
      made: ["YOUTUBE_REFRESH_TOKEN"],
    });
    expect(sink.values).toEqual({ YOUTUBE_REFRESH_TOKEN: "rt" });
    await expect(sites.setup("youtube", "oauth-client")).rejects.toMatchObject({ status: 501 });
    env.GOOGLE_OAUTH_CLIENT_ID = "";
    await expect(sites.setup("youtube", "consent")).rejects.toMatchObject({ status: 409 });
  });

  it("a consent that is refused or mismatched fails without keeping anything", async () => {
    const port = 9412;
    const spec = { ...youtube.auth, consentFlow: "google/oauth-consent" } as never;
    const browser = fakeBrowser([]);
    browser.on(consent, async () => {
      await fetch(`http://127.0.0.1:${port}/oauth/callback?error=access_denied&state=x`);
    });
    const o = "oauth" in youtube.auth ? youtube.auth.oauth : (spec as never);
    await expect(
      runConsent(o, {
        http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
        env: (n) => ({ GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "cs" })[n],
        runner: browser,
        flow: consent,
        port,
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it("a setup flow gets the sink and its input", async () => {
    const app = defineFlow<
      { redirectUri: string; sink: { put(n: string, v: string): Promise<void> } },
      void
    >({
      site: "linkedin",
      name: "developer-app",
      async run() {},
    });
    const browser = fakeBrowser([]);
    browser.on(app, async (i) => {
      expect(i.redirectUri).toBe("http://127.0.0.1:9400/oauth/callback");
      await i.sink.put("LINKEDIN_CLIENT_ID", "id");
      await i.sink.put("LINKEDIN_CLIENT_SECRET", "secret");
    });
    const sink = memorySink();
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: (n) => sink.values[n],
      sink,
      runner: browser,
      flow: (n) => (n === "linkedin/developer-app" ? (app as never) : null),
    });
    expect(await sites.setup("linkedin", "developer-app")).toEqual({
      made: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    });
    expect((await sites.status("linkedin")).setup[0]?.done).toBe(true);
    expect((await sites.status("linkedin")).setup[1]?.blockedOn).toEqual([]);
  });

  it("a custom site with a browser output mapping answers in the official shape", async () => {
    const stats = defineFlow<{ urn: string }, { likes: number; comments: number }>({
      site: "x",
      name: "stats",
      async run() {
        return { likes: 2, comments: 1 };
      },
    });
    const site: SiteApi = {
      site: "x",
      origin: "https://api.x.test",
      auth: { token: "X_TOKEN" },
      routes: [
        route({
          method: "GET",
          path: "/stats/{urn}",
          summary: "counts",
          request: z.object({ urn: z.string() }),
          browser: {
            flow: "x/stats",
            output: (o) => {
              const s = o as { likes: number; comments: number };
              return {
                likesSummary: { totalLikes: s.likes },
                commentsSummary: { totalFirstLevelComments: s.comments },
              };
            },
          },
        }),
      ],
      setup: [],
    };
    const browser = fakeBrowser([]);
    browser.on(stats, async () => ({ likes: 2, comments: 1 }));
    const sites = siteFacade([site], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => (n === "x/stats" ? (stats as never) : null),
    });
    expect(await sites.call("x", "GET", "/stats/u1", {})).toEqual({
      likesSummary: { totalLikes: 2 },
      commentsSummary: { totalFirstLevelComments: 1 },
    });
  });
});
