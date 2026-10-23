import { describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import {
  authorsOf,
  followedOf,
  metaOf,
  metricsOf,
  type RawTweet,
  searchUrl,
  type TimelineTweet,
  timelineTweets,
  tweetOf,
  userOf,
  xPosts,
} from "../src/browser/flows/x-read.js";
import { scrollCollect } from "../src/browser/scroll-collect.js";
import { fakePage } from "./auth-fakes.js";

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

  it("authors once each, as the API's includes.users", () => {
    const a = tweetOf(raw({}));
    const b = tweetOf(raw({ href: "/stripe/status/1972000000000000002" }));
    const c = tweetOf(raw({ user: "Synth\n@synth\n·\n1h", href: "/synth/status/3" }));
    if (!a || !b || !c) throw new Error("no tweet");
    expect(authorsOf([a, b, c])).toEqual([
      { username: "stripe", name: "Stripe" },
      { username: "synth", name: "Synth" },
    ]);
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

describe("followedOf", () => {
  it("reads the handle from the profile link and the name from the first line", () => {
    expect(
      followedOf({
        text: "Stripe\n@stripe\nFollows you\nFollowing\nPayments infrastructure",
        hrefs: ["/stripe", "/stripe/photo"],
      }),
    ).toEqual({ username: "stripe", name: "Stripe", follows_you: true });
  });

  it("keeps the handle as the name when the cell shows none, and needs a profile link", () => {
    expect(followedOf({ text: "@x_user\nFollowing", hrefs: ["/x_user"] })).toEqual({
      username: "x_user",
      name: "x_user",
      follows_you: false,
    });
    expect(followedOf({ text: "Someone", hrefs: ["/i/lists/1"] })).toBeNull();
  });
});

const user = (rest_id: string, screen_name: string, name: string) => ({
  result: { rest_id, core: { screen_name, name } },
});
const gql = (id: string, by: ReturnType<typeof user>, text: string, more: object = {}) => ({
  __typename: "Tweet",
  rest_id: id,
  core: { user_results: by },
  views: { count: "120" },
  legacy: {
    id_str: id,
    full_text: text,
    created_at: "Wed Oct 21 12:00:00 +0000 2026",
    conversation_id_str: id,
    reply_count: 1,
    retweet_count: 2,
    favorite_count: 3,
    bookmark_count: 0,
    ...more,
  },
});
const WREN = user("100", "wren_sample", "Wren");
const OTHER = user("200", "other_co", "Other Co");
const item = (result: object) => ({ itemContent: { tweet_results: { result } } });
/** One answer of the Replies tab: a pin, a reply under its parent, a post quoting another, a repost. */
const REPLIES_PAGE = {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [
              { type: "TimelinePinEntry", entry: { content: item(gql("1000", WREN, "Pinned")) } },
              {
                type: "TimelineAddEntries",
                entries: [
                  {
                    content: {
                      items: [
                        { item: item(gql("1004", OTHER, "Their post")) },
                        {
                          item: item(
                            gql("1005", WREN, "@other_co Good point &amp; more", {
                              in_reply_to_status_id_str: "1004",
                              in_reply_to_user_id_str: "200",
                              in_reply_to_screen_name: "other_co",
                              conversation_id_str: "1004",
                            }),
                          ),
                        },
                      ],
                    },
                  },
                  {
                    content: item({
                      __typename: "TweetWithVisibilityResults",
                      tweet: {
                        ...gql("1003", WREN, "short"),
                        note_tweet: {
                          note_tweet_results: { result: { text: "The whole long text" } },
                        },
                        quoted_status_result: { result: gql("900", OTHER, "quoted") },
                      },
                    }),
                  },
                  {
                    content: item(
                      gql("1002", WREN, "RT @other_co: x", {
                        retweeted_status_result: { result: gql("901", OTHER, "x") },
                      }),
                    ),
                  },
                  {
                    content: item(
                      gql("1001", WREN, "@gone hi", {
                        in_reply_to_status_id_str: "800",
                        in_reply_to_user_id_str: "300",
                        in_reply_to_screen_name: "gone",
                      }),
                    ),
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
};

describe("x timeline data", () => {
  it("reads each post with its reply fields; the parent's author from the answer, else the handle", () => {
    const rows = timelineTweets(REPLIES_PAGE);
    expect(rows.map((t) => [t.id, t.author_username, !!t.pinned, t.reposted_by ?? null])).toEqual([
      ["1000", "wren_sample", true, null],
      ["1004", "other_co", false, null],
      ["1005", "wren_sample", false, null],
      ["1003", "wren_sample", false, null],
      ["1002", "wren_sample", false, "Wren"],
      ["1001", "wren_sample", false, null],
    ]);
    expect(rows.find((t) => t.id === "1005")).toEqual({
      id: "1005",
      text: "@other_co Good point & more",
      author_username: "wren_sample",
      author_name: "Wren",
      url: "https://x.com/wren_sample/status/1005",
      created_at: "2026-10-21T12:00:00.000Z",
      conversation_id: "1004",
      in_reply_to_status_id: "1004",
      in_reply_to_user_id: "200",
      referenced_tweets: [{ type: "replied_to", id: "1004" }],
      in_reply_to: { username: "other_co", name: "Other Co" },
      public_metrics: {
        reply_count: 1,
        retweet_count: 2,
        like_count: 3,
        bookmark_count: 0,
        impression_count: 120,
      },
    });
    expect(rows.find((t) => t.id === "1003")?.text).toBe("The whole long text");
    expect(rows.find((t) => t.id === "1001")?.in_reply_to).toEqual({
      username: "gone",
      name: "gone",
    });
  });

  it("x/posts without replies excluded reads the Replies tab's data, newest first, as the API answers", async () => {
    type Handler = (r: {
      url: () => string;
      status: () => number;
      json: () => Promise<unknown>;
    }) => void;
    const handlers = new Set<Handler>();
    const opened: string[] = [];
    const { fp } = fakePage({ text: ["Wren"], present: () => true });
    fp.page = {
      on: (_e: string, h: Handler) => handlers.add(h),
      off: (_e: string, h: Handler) => handlers.delete(h),
      evaluate: async (fn: unknown) => (String(fn).includes("article") ? [raw({})] : 900),
    } as unknown as FlowPage["page"];
    let url = "";
    const clicks: string[] = [];
    let answers = 1;
    fp.open = async (to) => {
      opened.push(to);
      url = to.includes("/i/user/") ? "https://x.com/wren_sample" : to;
    };
    // Only the Replies tab's click makes the timeline call.
    fp.act = async (_a, hints, o) => {
      clicks.push(`${hints.role} ${hints.name}: ${o?.goal}`);
      url = `${url}/with_replies`;
      for (let n = 0; n < answers; n++)
        for (const h of handlers)
          h({
            url: () => "https://x.com/i/api/graphql/abc/UserTweetsAndReplies?variables=x",
            status: () => 200,
            json: async () => REPLIES_PAGE,
          });
      return { ok: true } as never;
    };
    fp.url = () => url;
    fp.scroll = async () => {};
    fp.wait = async () => {};
    const out = (await xPosts.run(fp, { id: "100", max_results: 3, exclude: "retweets" })) as {
      data: TimelineTweet[];
      meta: unknown;
    };
    expect(opened).toEqual(["https://x.com/i/user/100"]);
    expect(clicks).toEqual(["tab /^replies$/i: open the Replies tab"]);
    expect(out.data.map((t) => [t.id, t.in_reply_to_status_id ?? null])).toEqual([
      ["1005", "1004"],
      ["1003", null],
      ["1001", "800"],
    ]);
    expect(out.meta).toEqual({ result_count: 3, newest_id: "1005", oldest_id: "1001" });
    expect(handlers.size).toBe(0);
    // No timeline call after the click: an error naming what the page called, not an empty list.
    answers = 0;
    await expect(xPosts.run(fp, { id: "wren_sample" })).rejects.toThrow(
      /the Replies tab made no timeline call \(calls: 0 others; https:\/\/x.com\/wren_sample\/with_replies\)/,
    );
    expect(handlers.size).toBe(0);
  });
});
