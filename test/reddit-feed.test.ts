import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import { redditRead, WWW } from "../src/browser/flows/reddit.js";
import {
  decode,
  listingFromAtom,
  mdOf,
  parseAtom,
  threadFromAtom,
} from "../src/browser/flows/reddit-rss.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/reddit/${name}`, import.meta.url), "utf8");
const NEW = fixture("new-feed.xml");
const THREAD = fixture("thread.xml");
const SUBS = fixture("subreddits.xml");

describe("parseAtom", () => {
  it("reads each entry's id, author, sub, link, times and title; content comes back as HTML", () => {
    const [a, b, c] = parseAtom(NEW);
    expect(a).toMatchObject({
      id: "t3_aaa111",
      author: "example_poster_1",
      sub: "examplesub",
      href: "https://www.reddit.com/r/examplesub/comments/aaa111/invoices_eat_our_fridays/",
      published: "2026-01-05T12:10:00+00:00",
      title: "Invoices eat our Fridays & our nerves",
    });
    expect(a?.html).toContain('<div class="md">');
    expect(b?.id).toBe("t3_bbb222");
    // A deleted author has no <author> block.
    expect(c).toMatchObject({ id: "t3_ccc333", author: null });
  });

  it("anything that is not a feed has no entries", () => {
    for (const junk of ["", "<html>blocked</html>", "<feed></feed>", "{}"])
      expect(parseAtom(junk)).toEqual([]);
  });

  it("skips an entry whose id is not a thing name", () => {
    expect(parseAtom("<feed><entry><id>/r/x/</id><title>t</title></entry></feed>")).toEqual([]);
  });
});

describe("decode", () => {
  it("turns named, decimal and hex entities into characters, one level", () => {
    expect(decode("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x27;f&#x27;")).toBe(
      `a & b <c> "d" 'e' 'f'`,
    );
    expect(decode("&amp;amp;")).toBe("&amp;");
    expect(decode("&bogus; &#99999999999;")).toBe("&bogus; &#99999999999;");
  });
});

describe("mdOf", () => {
  it("keeps paragraphs, bold, links and bullets as markdown; entities decode", () => {
    const [a] = parseAtom(NEW);
    expect(mdOf(a?.html ?? "")).toBe(
      [
        "We're a 3-person shop & invoices eat our Fridays.",
        "",
        "Anyone automate this? See [this guide](https://example.com/guide?a=1&b=2) or **ask** me.",
        "",
        "- quotes",
        "- invoices",
      ].join("\n"),
    );
  });

  it("is empty for a link post, which carries no body", () => {
    const [, b] = parseAtom(NEW);
    expect(mdOf(b?.html ?? "")).toBe("");
  });

  it("keeps quotes, headings, code and a bare URL", () => {
    const html =
      '<!-- SC_OFF --><div class="md"><h2>Plan</h2><blockquote><p>said</p></blockquote><p>run <code>x</code> at <a href="https://e.test/a">https://e.test/a</a></p><pre><code>a &lt; b\n</code></pre></div><!-- SC_ON -->';
    expect(mdOf(html)).toBe("## Plan\n\n> said\n\nrun `x` at https://e.test/a\n\n```\na < b\n```");
  });
});

describe("listingFromAtom", () => {
  it("is the Data API's listing: self post, link post, deleted author", () => {
    const l = listingFromAtom(NEW, { limit: 25 });
    expect(l.kind).toBe("Listing");
    expect(l.data.after).toBeNull();
    expect(l.data.children.map((c) => c.kind)).toEqual(["t3", "t3", "t3"]);
    const [a, b, c] = l.data.children.map((x) => x.data);
    expect(a).toMatchObject({
      id: "aaa111",
      name: "t3_aaa111",
      title: "Invoices eat our Fridays & our nerves",
      author: "example_poster_1",
      subreddit: "examplesub",
      permalink: "/r/examplesub/comments/aaa111/invoices_eat_our_fridays/",
      url: "https://www.reddit.com/r/examplesub/comments/aaa111/invoices_eat_our_fridays/",
      created_utc: Date.parse("2026-01-05T12:10:00+00:00") / 1000,
      is_self: true,
      domain: "self.examplesub",
    });
    expect(String(a?.selftext)).toContain("invoices eat our Fridays");
    expect(b).toMatchObject({
      url: "https://www.example.org/tools/scheduler?x=1&y=2",
      is_self: false,
      domain: "example.org",
      selftext: "",
    });
    expect(c).not.toHaveProperty("author");
  });

  it("never invents numbers the feed lacks", () => {
    const [a] = listingFromAtom(NEW).data.children.map((c) => c.data);
    for (const k of [
      "score",
      "num_comments",
      "upvote_ratio",
      "locked",
      "archived",
      "stickied",
      "over_18",
      "removed_by_category",
      "link_flair_text",
    ])
      expect(a).not.toHaveProperty(k);
  });

  it("fills score and comment count only for the posts the page showed", () => {
    const l = listingFromAtom(NEW, {
      stats: [
        { id: "t3_aaa111", score: 7, comments: 4, ratio: 0.9 },
        { id: "t3_bbb222", score: undefined, comments: 0 },
        { id: "t3_zzz999", score: 5 },
      ],
    });
    const [a, b, c] = l.data.children.map((x) => x.data);
    expect(a).toMatchObject({ score: 7, num_comments: 4, upvote_ratio: 0.9 });
    expect(b).toMatchObject({ num_comments: 0 });
    expect(b).not.toHaveProperty("score");
    expect(c).not.toHaveProperty("num_comments");
  });

  it("`after` is the last name only when the feed is full", () => {
    expect(listingFromAtom(NEW, { limit: 3 }).data.after).toBe("t3_ccc333");
    expect(listingFromAtom(NEW, { limit: 4 }).data.after).toBeNull();
    expect(listingFromAtom(NEW, { limit: 3, paged: false }).data.after).toBeNull();
    expect(listingFromAtom("", { limit: 3 }).data).toEqual({
      after: null,
      before: null,
      children: [],
    });
  });

  it("subreddit search: t5 things with the name, title, blurb and birthday; no member count", () => {
    const l = listingFromAtom(SUBS);
    expect(l.data.children).toEqual([
      {
        kind: "t5",
        data: {
          id: "2examp",
          name: "t5_2examp",
          display_name: "examplesub",
          title: "examplesub: Examples for tests",
          public_description: "A made-up community for tests & fixtures.",
          created_utc: Date.parse("2010-03-04T05:06:07+00:00") / 1000,
          url: "/r/examplesub/",
        },
      },
      {
        kind: "t5",
        data: {
          id: "9two",
          name: "t5_9two",
          display_name: "ExampleTwo",
          title: "ExampleTwo",
          created_utc: Date.parse("2023-05-28T17:43:47+00:00") / 1000,
          url: "/r/ExampleTwo/",
        },
      },
    ]);
  });
});

describe("threadFromAtom", () => {
  it("the post, then every comment: body, author, link_id, time; no depth or score", () => {
    const [post, tree] = threadFromAtom(THREAD);
    expect(post.data.children).toHaveLength(1);
    expect(post.data.children[0]?.data).toMatchObject({
      name: "t3_aaa111",
      title: "Invoices eat our Fridays",
      selftext: "Invoices take all of Friday.",
      author: "example_poster_1",
    });
    expect(tree.data.children.map((c) => c.data.name)).toEqual([
      "t1_c1aaaa1",
      "t1_c2bbbb2",
      "t1_c3cccc3",
      "t1_c4dddd4",
    ]);
    expect(tree.data.children[1]?.data).toEqual({
      id: "c2bbbb2",
      name: "t1_c2bbbb2",
      body: "What tool do you invoice from?",
      author: "example_helper_1",
      permalink: "/r/examplesub/comments/aaa111/invoices_eat_our_fridays/c2bbbb2/",
      subreddit: "examplesub",
      link_id: "t3_aaa111",
      created_utc: Date.parse("2026-01-05T12:40:00+00:00") / 1000,
    });
  });

  it("with the rendered page: replies drop out as the API's listing drops them, top-level ones get parent and score", () => {
    const [post, tree] = threadFromAtom(THREAD, {
      post: { id: "t3_aaa111", score: 11, comments: 18, ratio: 1 },
      comments: [
        { id: "t1_c1aaaa1", depth: 0, score: 1 },
        { id: "t1_c2bbbb2", depth: 0, score: 3 },
        { id: "t1_c3cccc3", depth: 1, parent: "t1_c2bbbb2", score: 1 },
      ],
    });
    expect(post.data.children[0]?.data).toMatchObject({
      score: 11,
      num_comments: 18,
      upvote_ratio: 1,
    });
    const names = tree.data.children.map((c) => c.data.name);
    // c3 is a reply; c4 the page did not render, so it stays and its depth stays unknown.
    expect(names).toEqual(["t1_c1aaaa1", "t1_c2bbbb2", "t1_c4dddd4"]);
    expect(tree.data.children[1]?.data).toMatchObject({ parent_id: "t3_aaa111", score: 3 });
    expect(tree.data.children[2]?.data).not.toHaveProperty("parent_id");
    expect(tree.data.children[2]?.data).not.toHaveProperty("score");
  });

  it("a page about another post lends it nothing", () => {
    const [post] = threadFromAtom(THREAD, {
      post: { id: "t3_other", score: 99 },
      comments: [],
    });
    expect(post.data.children[0]?.data).not.toHaveProperty("score");
  });

  it("no post in the feed: an empty post listing, never a throw", () => {
    const [post, tree] = threadFromAtom("");
    expect(post.data.children).toEqual([]);
    expect(tree.data.children).toEqual([]);
  });
});

/**
 * A fake www page: `page.evaluate` runs the flow's own script against stubbed `fetch` and
 * `document`, so the feed fetch and the rendered-page reads are both exercised.
 */
function wwwPage(o: {
  json?: number;
  feeds?: Record<string, { status: number; text?: string }>;
  dom?: Record<string, Array<Record<string, string>>>;
  openFails?: boolean;
}) {
  let url = "about:blank";
  const fetched: string[] = [];
  const opens: string[] = [];
  vi.stubGlobal("fetch", async (u: string) => {
    fetched.push(u);
    const feed = Object.entries(o.feeds ?? {}).find(([k]) => u.includes(k));
    const a = u.includes(".json")
      ? { status: o.json ?? 403, text: "" }
      : (feed?.[1] ?? { status: 404 });
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      json: async () => ({}),
      text: async () => a.text ?? "",
    };
  });
  vi.stubGlobal("document", {
    querySelectorAll: (sel: string) =>
      (o.dom?.[sel] ?? []).map((attrs) => ({ getAttribute: (n: string) => attrs[n] ?? null })),
  });
  const fp = {
    page: { evaluate: async (fn: (a: unknown) => unknown, arg?: unknown) => fn(arg) },
    async open(u: string) {
      opens.push(u);
      if (o.openFails && u.includes("/comments/")) throw new Error("wall");
      url = u;
    },
    url: () => url,
  } as unknown as FlowPage;
  return { fp, fetched, opens };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("reddit/read signed out, `.json` refused", () => {
  it("answers a subreddit's new from its feed, with score and comments off the page", async () => {
    const p = wwwPage({
      feeds: { "/r/examplesub/new/.rss": { status: 200, text: NEW } },
      dom: {
        "shreddit-post": [
          { id: "t3_aaa111", score: "7", "comment-count": "4", "upvote-ratio": "1" },
        ],
      },
    });
    const out = (await redditRead.run(p.fp, {
      path: "/r/examplesub/new",
      query: { limit: 3, raw_json: 1 },
      signedOut: true,
    })) as ReturnType<typeof listingFromAtom>;
    // The refused .json first, then its twin; raw_json is the API's flag and does not ride along.
    expect(p.fetched[0]).toContain("/r/examplesub/new.json");
    expect(p.fetched[1]).toBe(`${WWW}/r/examplesub/new/.rss?limit=3`);
    expect(p.opens).toContain(`${WWW}/r/examplesub/new/`);
    expect(out.data.children).toHaveLength(3);
    expect(out.data.after).toBe("t3_ccc333");
    expect(out.data.children[0]?.data).toMatchObject({
      name: "t3_aaa111",
      score: 7,
      num_comments: 4,
    });
    expect(out.data.children[1]?.data).not.toHaveProperty("num_comments");
  });

  it("top takes its window to the page too", async () => {
    const p = wwwPage({ feeds: { "/r/examplesub/top/.rss": { status: 200, text: NEW } } });
    await redditRead.run(p.fp, {
      path: "/r/examplesub/top",
      query: { t: "week", limit: 25 },
      signedOut: true,
    });
    expect(p.fetched[1]).toBe(`${WWW}/r/examplesub/top/.rss?t=week&limit=25`);
    expect(p.opens).toContain(`${WWW}/r/examplesub/top/?t=week`);
  });

  it("a thread is the post and its top-level comments; replies the page showed drop out", async () => {
    const p = wwwPage({
      feeds: { "/comments/aaa111/.rss": { status: 200, text: THREAD } },
      dom: {
        "shreddit-post": [{ id: "t3_aaa111", score: "11", "comment-count": "18" }],
        "shreddit-comment": [
          { thingid: "t1_c2bbbb2", depth: "0", score: "3" },
          { thingid: "t1_c3cccc3", depth: "1", parentid: "t1_c2bbbb2", score: "1" },
        ],
      },
    });
    const [post, tree] = (await redditRead.run(p.fp, {
      path: "/comments/aaa111",
      query: { limit: 100 },
      signedOut: true,
    })) as ReturnType<typeof threadFromAtom>;
    expect(p.fetched[1]).toBe(`${WWW}/comments/aaa111/.rss?limit=100`);
    expect(post.data.children[0]?.data).toMatchObject({ score: 11, num_comments: 18 });
    expect(tree.data.children.map((c) => c.data.name)).toEqual([
      "t1_c1aaaa1",
      "t1_c2bbbb2",
      "t1_c4dddd4",
    ]);
  });

  it("a page that will not load costs the numbers, not the read", async () => {
    const p = wwwPage({
      feeds: { "/comments/aaa111/.rss": { status: 200, text: THREAD } },
      openFails: true,
    });
    const [post, tree] = (await redditRead.run(p.fp, {
      path: "/comments/aaa111",
      signedOut: true,
    })) as ReturnType<typeof threadFromAtom>;
    expect(post.data.children[0]?.data).not.toHaveProperty("score");
    expect(tree.data.children).toHaveLength(4);
  });

  it("subreddit search and site search use their feeds, without a page", async () => {
    const p = wwwPage({ feeds: { "/subreddits/search/.rss": { status: 200, text: SUBS } } });
    const out = (await redditRead.run(p.fp, {
      path: "/subreddits/search",
      query: { q: "small business", limit: 10 },
      signedOut: true,
    })) as ReturnType<typeof listingFromAtom>;
    // %20, not +: the same rule the .json read follows.
    expect(p.fetched[1]).toBe(`${WWW}/subreddits/search/.rss?q=small%20business&limit=10`);
    expect(out.data.children.map((c) => c.kind)).toEqual(["t5", "t5"]);
    expect(p.opens).toEqual([`${WWW}/`]);
  });

  it("a feed 404 is the read's 404", async () => {
    const p = wwwPage({ feeds: { "/r/nosuchsub/new/.rss": { status: 404 } } });
    expect(await redditRead.run(p.fp, { path: "/r/nosuchsub/new", signedOut: true })).toMatchObject(
      { error: 404 },
    );
  });

  it("any other feed status fails the read", async () => {
    const p = wwwPage({ feeds: { "/r/examplesub/new/.rss": { status: 429 } } });
    await expect(
      redditRead.run(p.fp, { path: "/r/examplesub/new", signedOut: true }),
    ).rejects.toThrow(/HTTP 429/);
  });

  it("a path no feed serves still fails on the 403 (the subreddit card has no feed)", async () => {
    const p = wwwPage({});
    await expect(
      redditRead.run(p.fp, { path: "/r/examplesub/about", signedOut: true }),
    ).rejects.toThrow(/HTTP 403/);
    expect(p.fetched).toHaveLength(1);
  });

  it("signed in, a 403 is still a failure: no feed stands in", async () => {
    const p = wwwPage({ feeds: { "/r/examplesub/new/.rss": { status: 200, text: NEW } } });
    await expect(redditRead.run(p.fp, { path: "/r/examplesub/new" })).rejects.toThrow(/HTTP 403/);
    expect(p.fetched).toHaveLength(1);
  });

  it("an answering `.json` is still the way, feeds untouched", async () => {
    const p = wwwPage({ json: 200 });
    await redditRead.run(p.fp, { path: "/r/examplesub/new", signedOut: true });
    expect(p.fetched).toHaveLength(1);
  });
});
