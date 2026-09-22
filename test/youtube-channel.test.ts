import { describe, expect, it } from "vitest";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { siteFacade, youtube } from "../src/sites/index.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

/** A token that owns `channel`, and a facade over it with whatever env the test wants. */
function facade(channel: string, env: Record<string, string>) {
  const calls: string[] = [];
  // A distinct bearer per facade: the channel lookup is remembered per token.
  const token = `at-${channel}-${Math.random().toString(36).slice(2)}`;
  const api = fakeFetch(({ url }) => {
    if (url.host === "oauth2.googleapis.com")
      return { body: { access_token: token, expires_in: 3600 } };
    calls.push(url.pathname);
    if (url.pathname === "/youtube/v3/channels") return { body: { items: [{ id: channel }] } };
    return { body: { id: "posted" } };
  });
  const sites = siteFacade([youtube], {
    http: httpClient({ fetch: api.fetch }),
    env: (n) => env[n],
    sink: memorySink(),
    runner: fakeBrowser([]),
    flow: () => null,
  });
  return { sites, calls };
}

const KEYS = {
  GOOGLE_OAUTH_CLIENT_ID: "cid",
  GOOGLE_OAUTH_CLIENT_SECRET: "cs",
  YOUTUBE_REFRESH_TOKEN: "rt",
};
const comment = {
  part: "snippet",
  snippet: { videoId: "v1", topLevelComment: { snippet: { textOriginal: "hi" } } },
};

describe("youtube writes stay on the configured channel", () => {
  it("refuses when the token is on another channel", async () => {
    const { sites } = facade("UC-personal", { ...KEYS, YOUTUBE_CHANNEL_ID: "UC-wren" });
    await expect(
      sites.call("youtube", "POST", "/youtube/v3/commentThreads", comment),
    ).rejects.toThrow(/UC-personal, not YOUTUBE_CHANNEL_ID=UC-wren/);
  });

  it("refuses when no channel is configured at all", async () => {
    const { sites } = facade("UC-personal", { ...KEYS });
    await expect(
      sites.call("youtube", "POST", "/youtube/v3/commentThreads", comment),
    ).rejects.toThrow(/set YOUTUBE_CHANNEL_ID/);
  });

  it("writes when they match, and looks the channel up once", async () => {
    const { sites, calls } = facade("UC-wren", { ...KEYS, YOUTUBE_CHANNEL_ID: "UC-wren" });
    await sites.call("youtube", "POST", "/youtube/v3/commentThreads", comment);
    await sites.call("youtube", "POST", "/youtube/v3/commentThreads", comment);
    expect(calls.filter((p) => p === "/youtube/v3/channels")).toHaveLength(1);
  });

  it("leaves reads alone", async () => {
    const { sites } = facade("UC-personal", { ...KEYS });
    await expect(
      sites.call("youtube", "GET", "/youtube/v3/videos", { part: "statistics", id: "v1" }),
    ).resolves.toBeDefined();
  });
});

describe("a browser leg runs as the site's own account", () => {
  it("re-sites the flow at the profile that holds it", async () => {
    let ranAs = "";
    const sites = siteFacade([youtube], {
      http: httpClient({ fetch: fakeFetch(() => ({ body: {} })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: {
        run: async (flow: { site: string }) => {
          ranAs = flow.site;
          return { url: null };
        },
      } as never,
      flow: (name: string) =>
        name === "google/youtube-community-post"
          ? ({ site: "google", name: "youtube-community-post", run: async () => ({}) } as never)
          : null,
      accountFor: async () => "william@wrenautomation.com",
      providerOf: () => "google",
      profileFor: async (at: string, who: string) =>
        at === "google" && who === "william@wrenautomation.com" ? "google-admin" : null,
    });
    await sites.call("youtube", "POST", "/studio/communityPosts", { text: "hi" });
    expect(ranAs).toBe("google-admin");
  });
});
