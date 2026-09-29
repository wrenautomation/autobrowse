import { describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import {
  metaOf,
  metricsOf,
  type RawTweet,
  searchUrl,
  tweetOf,
  userOf,
} from "../src/browser/flows/x-read.js";
import { proxyFor, proxyOf } from "../src/browser/proxy.js";
import { scrollCollect } from "../src/browser/scroll-collect.js";

const raw = (o: Partial<RawTweet>): RawTweet => ({
  user: "Stripe\n@stripe\n·\n4h",
  text: "hello",
  time: "2026-09-29T10:00:00.000Z",
  href: "/stripe/status/1972000000000000001",
  social: "",
  metrics: "82 replies, 64 reposts, 555 likes, 312 bookmarks, 122909 views",
  photos: [],
  ...o,
});

describe("x page parsers", () => {
  it("reads a post's id, author and counts off the article", () => {
    expect(tweetOf(raw({}))).toEqual({
      id: "1972000000000000001",
      text: "hello",
      author_username: "stripe",
      author_name: "Stripe",
      created_at: "2026-09-29T10:00:00.000Z",
      public_metrics: {
        reply_count: 82,
        retweet_count: 64,
        like_count: 555,
        bookmark_count: 312,
        impression_count: 122909,
      },
    });
    expect(tweetOf(raw({ social: "Pinned" }))?.pinned).toBe(true);
    expect(tweetOf(raw({ social: "Stripe reposted" }))?.reposted_by).toBe("Stripe");
    // An ad has no status link.
    expect(tweetOf(raw({ href: null }))).toBeNull();
  });

  it("counts: singulars, commas, and missing ones as zero", () => {
    expect(metricsOf("1 reply, 1,204 likes")).toEqual({
      reply_count: 1,
      retweet_count: 0,
      like_count: 1204,
      bookmark_count: 0,
      impression_count: 0,
    });
  });

  it("meta skips a pinned post and orders ids as numbers, not strings", () => {
    const posts = [
      raw({ href: "/a/status/99", social: "Pinned" }),
      raw({ href: "/a/status/1000" }),
      raw({ href: "/a/status/200" }),
    ]
      .map(tweetOf)
      .filter((t) => t !== null);
    expect(metaOf(posts)).toEqual({ result_count: 3, newest_id: "1000", oldest_id: "200" });
    expect(metaOf([])).toEqual({ result_count: 0 });
  });

  it("a profile from its JSON-LD", () => {
    const ld = {
      dateCreated: "2009-01-01T00:00:00.000Z",
      relatedLink: ["https://t.co/abc", "https://stripe.com"],
      mainEntity: {
        identifier: "102812444",
        additionalName: "stripe",
        name: "Stripe",
        description: "Financial infrastructure",
        homeLocation: { name: "San Francisco" },
        image: { contentUrl: "https://pbs.twimg.com/p.jpg" },
        interactionStatistic: [
          { name: "Follows", userInteractionCount: 900 },
          { name: "Friends", userInteractionCount: 10 },
          { name: "Tweets", userInteractionCount: 5000 },
        ],
      },
    };
    expect(userOf(ld)).toEqual({
      id: "102812444",
      username: "stripe",
      name: "Stripe",
      description: "Financial infrastructure",
      location: "San Francisco",
      url: "https://stripe.com",
      created_at: "2009-01-01T00:00:00.000Z",
      profile_image_url: "https://pbs.twimg.com/p.jpg",
      public_metrics: { followers_count: 900, following_count: 10, tweet_count: 5000 },
    });
    expect(userOf({ "@type": "WebPage" })).toBeNull();
  });

  it("search is Latest", () => {
    expect(searchUrl("from:stripe ai")).toBe(
      "https://x.com/search?q=from%3Astripe+ai&f=live&src=typed_query",
    );
  });
});

/** A feed of `rows` whose window shows `view` rows and moves one row per scroll. */
function feedPage(rows: string[], view = 3) {
  let top = 0;
  const scrolls: number[] = [];
  const fp = {
    page: { evaluate: async () => 900 },
    scroll: async (dy: number) => {
      scrolls.push(dy);
      top++;
    },
    wait: async () => {},
  } as unknown as FlowPage;
  return { fp, scrolls, read: async () => rows.slice(top, top + view) };
}

describe("scrollCollect", () => {
  it("keeps rows by key across scrolls and stops at max", async () => {
    const f = feedPage(["a", "b", "c", "d", "e", "f"]);
    const got = await scrollCollect(f.fp, { read: f.read, key: (r) => r, max: 5, settleMs: 0 });
    expect(got).toEqual({ rows: ["a", "b", "c", "d", "e"], ended: "max" });
    expect(f.scrolls.every((d) => d === Math.round(900 * 0.85))).toBe(true);
  });

  it("stops at the cursor, leaving it out, and never asks about skipped rows", async () => {
    const f = feedPage(["pin", "n3", "n2", "old", "older"]);
    const got = await scrollCollect(f.fp, {
      read: f.read,
      key: (r) => r,
      max: 50,
      skip: (r) => r === "pin",
      stop: (r) => r.startsWith("old") || r === "pin",
      settleMs: 0,
    });
    expect(got).toEqual({ rows: ["pin", "n3", "n2"], ended: "cursor" });
  });

  it("ends after idle scrolls bring nothing new", async () => {
    const f = feedPage(["a", "b"]);
    const got = await scrollCollect(f.fp, {
      read: f.read,
      key: (r) => r,
      max: 50,
      idle: 2,
      settleMs: 0,
    });
    expect(got).toEqual({ rows: ["a", "b"], ended: "end" });
  });
});

describe("browser proxy", () => {
  it("serves only the listed sites, by the profile's base site", () => {
    const of = proxyFor("http://u%40x:p%3Aw@isp.example:8080", "x, LinkedIn");
    expect(of("x@wren")).toEqual({
      server: "http://isp.example:8080",
      username: "u@x",
      password: "p:w",
    });
    expect(of("linkedin")).not.toBeNull();
    expect(of("google")).toBeNull();
    expect(proxyFor(undefined, "x")("x")).toBeNull();
    expect(proxyFor("http://h:1", "")("x")).toBeNull();
    // One profile, not the whole site: his own `linkedin` stays on its own IP.
    const one = proxyFor("http://h:1", "linkedin@research");
    expect(one("linkedin@research")).not.toBeNull();
    expect(one("linkedin")).toBeNull();
  });

  it("a bad URL is refused without echoing it", () => {
    expect(() => proxyOf("secret-pass@nohost")).toThrow(/^BROWSER_PROXY is not a URL/);
    expect(() => proxyOf("ftp://user:secret@h:1")).toThrow(/http, https or socks5/);
    try {
      proxyOf("ftp://user:secret@h:1");
    } catch (e) {
      expect(String(e)).not.toContain("secret");
    }
  });
});
