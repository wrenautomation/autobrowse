import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFlow } from "../src/browser/flow.js";
import { googleOauthConsent } from "../src/browser/flows/oauth-consent.js";
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
import { fakeBrowser, fakeFetch } from "./fakes.js";

const _whoami = defineFlow<Record<string, never>, { sub: string }>({
  site: "linkedin",
  name: "whoami",
  async run() {
    return { sub: "browser-sub" };
  },
});
const _createPost = defineFlow<{ text: string; visibility: string }, { id: string }>({
  site: "linkedin",
  name: "create-post",
  async run() {
    return { id: "urn:li:share:9" };
  },
});
const _consent = defineFlow<{ url: string }, void>({
  site: "google",
  name: "oauth-consent",
  async run() {},
});

const person = "urn:li:person:abc";

/** A compiled catalog whose workflows run through a function per name. */
function compiledOf(runs: Record<string, (plan: Record<string, unknown>) => Promise<unknown>>) {
  return {
    get: async (name: string) => (runs[name] ? ({ name } as never) : null),
    run: async (w: { name: string }, plan: Record<string, unknown>) => ({
      status: "done" as const,
      steps: [],
      output: (await runs[w.name]?.(plan)) as Record<string, string> | null,
    }),
  };
}

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
    // A fixed prefix around the param (Graph's ad accounts).
    expect(matchPath("/act_{adAccountId}/campaigns", "/act_123/campaigns")).toEqual({
      adAccountId: "123",
    });
    expect(matchPath("/act_{adAccountId}/campaigns", "/123/campaigns")).toBeNull();
    expect(matchPath("/act_{adAccountId}/campaigns", "/act_/campaigns")).toBeNull();
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
    const sites = siteFacade([linkedin], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
      compiled: compiledOf({
        "linkedin-whoami": async () => ({ sub: "browser-sub" }),
        "linkedin-create-post": async (plan) => {
          expect(plan).toEqual({ text: "hello", visibility: "PUBLIC" });
          return { id: "urn:li:share:9" };
        },
      }),
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
      message: expect.stringMatching(/workflow linkedin-post-stats not recorded/),
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
      missing: "workflow linkedin-post-stats not recorded",
    });
    // /rest/posts/{urn} has no browser leg: without a token it says so.
    expect(row.routes.find((r) => r.path === "/rest/posts/{urn}")).toMatchObject({ via: "none" });
    expect(row.setup.map((s) => [s.name, s.done, s.blockedOn, s.unrecorded])).toEqual([
      ["developer-app", false, [], "workflow linkedin-developer-app"],
      [
        "consent",
        false,
        ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
        "flow linkedin/oauth-consent",
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
      missing: "flow google/youtube-community-post not recorded",
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
    const env: Record<string, string> = {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "cs",
    };
    const sink = memorySink();
    // The consent walk is the hand-written google/oauth-consent flow; here a fake stands in for the browser.
    const browser = fakeBrowser([]);
    browser.on(googleOauthConsent, async ({ url }) => {
      const u = new URL(url);
      expect(u.searchParams.get("client_id")).toBe("cid");
      expect(u.searchParams.get("access_type")).toBe("offline");
      expect(u.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/oauth/callback`);
      // The consent page redirects to loopback with the code and our state.
      await fetch(
        `http://127.0.0.1:${port}/oauth/callback?code=the-code&state=${u.searchParams.get("state")}`,
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
    });
    await expect(sites.setup("youtube", "consent")).resolves.toEqual({
      made: ["YOUTUBE_REFRESH_TOKEN"],
    });
    expect(sink.values).toEqual({ YOUTUBE_REFRESH_TOKEN: "rt" });
    // The client step needs the project first (409); with it, its workflow is not compiled here (501).
    await expect(sites.setup("youtube", "oauth-client")).rejects.toMatchObject({ status: 409 });
    env.GOOGLE_CLOUD_PROJECT = "p1";
    await expect(sites.setup("youtube", "oauth-client")).rejects.toMatchObject({ status: 501 });
    env.GOOGLE_OAUTH_CLIENT_ID = "";
    await expect(sites.setup("youtube", "consent")).rejects.toMatchObject({ status: 409 });
  });

  it("a consent that is refused or mismatched fails without keeping anything", async () => {
    const port = 9412;
    const o = "oauth" in youtube.auth ? youtube.auth.oauth : (null as never);
    await expect(
      runConsent(o, {
        http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
        env: (n) => ({ GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "cs" })[n],
        open: async () => {
          await fetch(`http://127.0.0.1:${port}/oauth/callback?error=access_denied&state=x`);
        },
        port,
      }),
    ).rejects.toThrow(/state mismatch/);
  });

  it("a setup step runs a hand-written flow with the sink, or a compiled workflow with the plan", async () => {
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
    const handWritten: SiteApi = {
      ...linkedin,
      setup: [
        {
          ...(linkedin.setup[0] as never),
          how: {
            flow: "linkedin/developer-app",
            input: { redirectUri: "http://127.0.0.1:9400/oauth/callback" },
          },
        },
        linkedin.setup[1] as never,
      ],
    };
    const sites = siteFacade([handWritten], {
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

  it("a compiled workflow is a browser leg: its plan is the request, its output the answer, gates approved", async () => {
    const seen: unknown[] = [];
    const site: SiteApi = {
      site: "x",
      origin: "https://api.x.test",
      auth: { token: "X_TOKEN" },
      routes: [
        route({
          method: "POST",
          path: "/posts",
          summary: "post",
          irreversible: true,
          request: z.object({ text: z.string() }),
          browser: { workflow: "x-create-post", output: (o) => ({ id: (o as { id: string }).id }) },
        }),
        route({
          method: "GET",
          path: "/nothing",
          summary: "unrecorded",
          request: z.object({}),
          browser: { workflow: "x-nothing" },
        }),
      ],
      setup: [],
    };
    const workflow = { name: "x-create-post" } as never;
    const sites = siteFacade([site], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: fakeBrowser([]),
      flow: () => null,
      compiled: {
        get: async (name) => (name === "x-create-post" ? workflow : null),
        run: async (w, plan) => {
          seen.push([w, plan]);
          return plan.text === "boom"
            ? {
                status: "failed",
                steps: [{ name: "post", status: "failed", detail: "no button" }],
                output: null,
              }
            : { status: "done", steps: [], output: { id: "p1" } };
        },
      },
    });
    expect(await sites.call("x", "POST", "/posts", { text: "hi" })).toEqual({ id: "p1" });
    expect(seen).toEqual([[workflow, { text: "hi" }]]);
    await expect(sites.call("x", "POST", "/posts", { text: "boom" })).rejects.toMatchObject({
      status: 502,
      message: "x-create-post failed at post: no button",
    });
    const row = await sites.status("x");
    expect(row.routes.map((r) => [r.via, r.missing])).toEqual([
      ["browser", undefined],
      ["none", "workflow x-nothing not recorded"],
    ]);
  });
});
