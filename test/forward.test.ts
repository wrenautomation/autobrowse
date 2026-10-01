/** A run's events to the caller's hook: who may be fed, how posts batch, what a dead hook costs. */
import { describe, expect, it } from "vitest";
import { forwardChannel } from "../src/channels/forward.js";
import type { RunEvent } from "../src/engine/events.js";
import { FeedRefused, feedFrom, hostAllowed } from "../src/engine/feed.js";

const tp = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
const h = (o: Record<string, string>) => new Map(Object.entries(o));
const ev = (n: number): RunEvent => ({
  type: "step",
  run: { workflow: "w", key: "k" },
  at: new Date(n).toISOString(),
  step: `s${n}`,
  result: { status: "done" } as never,
});
const feed = { url: "https://feed.example.com/hook", tag: "wren-1", traceparent: tp };

describe("feedFrom", () => {
  const hosts = ["feed.example.com", "*.wren.test"];
  it("is null without x-feed-url and a feed with one on an allowed host", () => {
    expect(feedFrom(h({}), hosts)).toBeNull();
    expect(
      feedFrom(h({ "x-feed-url": feed.url, "x-feed-tag": "wren-1", traceparent: tp }), hosts),
    ).toEqual(feed);
    expect(
      feedFrom(h({ "X-Feed-Url": "https://app.wren.test/x", "x-feed-tag": "t" }), hosts),
    ).toEqual({
      url: "https://app.wren.test/x",
      tag: "t",
    });
  });
  it("refuses http, other hosts, credentials in the URL, a missing tag, and any feed when FEED_HOSTS is unset", () => {
    const bad = [
      [{ "x-feed-url": "http://feed.example.com/h", "x-feed-tag": "t" }, /https/],
      [{ "x-feed-url": "https://169.254.169.254/latest", "x-feed-tag": "t" }, /not in FEED_HOSTS/],
      [{ "x-feed-url": "https://u:p@feed.example.com/h", "x-feed-tag": "t" }, /credentials/],
      [{ "x-feed-url": "https://feed.example.com/h" }, /x-feed-tag/],
      [{ "x-feed-url": "not a url", "x-feed-tag": "t" }, /not a URL/],
    ] as const;
    for (const [headers, why] of bad) {
      expect(() => feedFrom(h(headers), hosts)).toThrow(FeedRefused);
      expect(() => feedFrom(h(headers), hosts)).toThrow(why);
    }
    expect(() => feedFrom(h({ "x-feed-url": feed.url, "x-feed-tag": "t" }), [])).toThrow(
      /FEED_HOSTS is unset/,
    );
  });
  it("drops a malformed traceparent and keeps the feed", () => {
    expect(
      feedFrom(h({ "x-feed-url": feed.url, "x-feed-tag": "t", traceparent: "junk" }), hosts),
    ).toEqual({ url: feed.url, tag: "t" });
  });
  it("a wildcard covers hosts under it, never the apex or a lookalike", () => {
    expect(hostAllowed("a.wren.test", ["*.wren.test"])).toBe(true);
    expect(hostAllowed("wren.test", ["*.wren.test"])).toBe(false);
    expect(hostAllowed("evilwren.test", ["*.wren.test"])).toBe(false);
    expect(hostAllowed("feed.example.com.evil.net", ["feed.example.com"])).toBe(false);
  });
});

function hook(status = 200) {
  const posts: {
    url: string;
    init: RequestInit;
    body: { tag: string; traceparent?: string; events: { seq: number; event: RunEvent }[] };
  }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, init, body: JSON.parse(String(init.body)) });
    if (status === 0) throw new TypeError("fetch failed");
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { posts, fetch };
}

describe("forwardChannel", () => {
  it("posts batches of 20 at once and the rest on flush, bearer from the box, never redirected", async () => {
    const { posts, fetch } = hook();
    const ch = forwardChannel({ token: "box-token", fetch, everyMs: 60_000 });
    for (let i = 1; i <= 25; i++) await ch.deliver(ev(i), { ...feed, seq: i });
    await ch.flush();
    expect(posts.map((p) => p.body.events.length)).toEqual([20, 5]);
    expect(posts[0]?.body).toMatchObject({ tag: "wren-1", traceparent: tp });
    expect(posts[1]?.body.events[0]?.seq).toBe(21);
    const headers = posts[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer box-token");
    expect(headers.traceparent).toBe(tp);
    expect(posts[0]?.init.redirect).toBe("manual");
  });

  it("sends what waits after about a second", async () => {
    const { posts, fetch } = hook();
    const ch = forwardChannel({ fetch, everyMs: 20 });
    await ch.deliver(ev(1), { ...feed, seq: 1 });
    expect(posts).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.init.headers).not.toHaveProperty("authorization");
  });

  it("passes events without a feed by, and a dead hook costs the run nothing", async () => {
    const dead = hook(0);
    const lines: string[] = [];
    const ch = forwardChannel({ fetch: dead.fetch, everyMs: 60_000, log: (l) => lines.push(l) });
    await ch.deliver(ev(1));
    await ch.flush();
    expect(dead.posts).toHaveLength(0);
    await expect(ch.deliver(ev(2), { ...feed, seq: 1 })).resolves.toBeUndefined();
    await expect(ch.flush()).resolves.toBeUndefined();
    expect(lines).toEqual(["feed post to feed.example.com: TypeError"]);
  });

  it("holds at most `max` per feed: the oldest go, a gap in seq says so", async () => {
    const { posts, fetch } = hook();
    const ch = forwardChannel({ fetch, everyMs: 60_000, batch: 100, max: 3 });
    for (let i = 1; i <= 5; i++) await ch.deliver(ev(i), { ...feed, seq: i });
    await ch.flush();
    expect(posts[0]?.body.events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
});
