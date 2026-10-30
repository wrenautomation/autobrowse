/**
 * Per-route verify reads (designs/2026-10-16-send-verdicts.md, "Verify per route"). Synthetic
 * fixtures only: a fake `get` answers each read route's real answer shape. Each test also checks
 * that every read hits a real read route of its site, with the right method.
 */
import { describe, expect, it } from "vitest";
import { matchPath } from "../src/sites/facade.js";
import { SITES } from "../src/sites/index.js";
import type { Seen, VerifyGet } from "../src/sites/verdict.js";
import { settle } from "../src/sites/verdict.js";

const SINCE = "2026-10-16T12:00:00.000Z";
const SENT = "2026-10-16T12:00:30.000Z";
const OLD = "2026-10-15T09:00:00.000Z";
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const siteOf = (name: string) => {
  const s = SITES.find((x) => x.site === name);
  if (!s) throw new Error(`no site ${name}`);
  return s;
};
const routeOf = (site: string, method: string, path: string) => {
  const r = siteOf(site).routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r;
};

type Answer = unknown | ((input: Record<string, unknown> | undefined) => unknown);
interface Call {
  method: string;
  path: string;
  input?: Record<string, unknown>;
}

/** A fake `get`: answers by `METHOD path`, records every call, fails on a path nobody expects. */
function fake(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const get: VerifyGet = async (path, input, o) => {
    const method = o?.method ?? "GET";
    calls.push({ method, path, input });
    const key = `${method} ${path}`;
    if (!(key in answers)) throw new Error(`unexpected read ${key}`);
    const a = answers[key];
    return typeof a === "function" ? (a as (i?: Record<string, unknown>) => unknown)(input) : a;
  };
  return { get, calls };
}

interface Out {
  seen: Seen;
  calls: Call[];
}

/** Run one route's verify as the service will: read, then settle. */
async function run(
  site: string,
  method: string,
  path: string,
  raw: unknown,
  answers: Record<string, Answer>,
  since = SINCE,
): Promise<Out> {
  const route = routeOf(site, method, path);
  const v = route.verify;
  if (!v || "none" in v) throw new Error(`${method} ${path} has no verify read`);
  const input = route.request.parse(raw) as never;
  const { get, calls } = fake(answers);
  const got = await v.read(input, get);
  const seen = settle(got, { words: v.words(input), since, lags: v.lags?.(input) ?? null });
  // Every read goes to a read route of the site, by the method it names.
  for (const c of calls) {
    const target = siteOf(site).routes.find(
      (r) => r.method === c.method && matchPath(r.path, c.path),
    );
    expect(target, `${c.method} ${c.path} is not a route of ${site}`).toBeDefined();
    expect(target?.irreversible, `${c.method} ${c.path} writes`).toBeFalsy();
  }
  return { seen, calls };
}
const found = (s: Seen) => (s.seen === "found" ? s : null);

describe("every irreversible route has a verify", () => {
  const irreversible = SITES.flatMap((s) =>
    s.routes.filter((r) => r.irreversible).map((r) => ({ site: s.site, route: r })),
  );

  it("finds the routes", () => {
    expect(irreversible.length).toBeGreaterThanOrEqual(46);
  });

  for (const { site, route } of irreversible) {
    it(`${site} ${route.method} ${route.path}`, () => {
      const v = route.verify;
      expect(v, "verify is missing").toBeDefined();
      if (v && "none" in v) expect(v.none.trim().length).toBeGreaterThan(10);
      else {
        expect(typeof v?.read).toBe("function");
        expect(typeof v?.words).toBe("function");
      }
    });
  }
});

describe("reddit", () => {
  const ME = { "GET /api/v1/me": { name: "tester_one" } };
  const child = (d: Record<string, unknown>) => ({ kind: "t1", data: d });
  const listing = (kids: unknown[], after: string | null = null) => ({
    data: { children: kids, after },
  });
  const THREAD = { thing_id: "t3_abc123", text: "Caching helps most when reads dominate." };

  it("comment: found under that parent, with its fullname", async () => {
    const r = await run("reddit", "POST", "/api/comment", THREAD, {
      ...ME,
      "GET /user/tester_one/comments": listing([
        child({
          name: "t1_zzz",
          parent_id: "t3_abc123",
          body: THREAD.text,
          created_utc: sec(SENT),
          permalink: "/r/x/comments/abc123/t/zzz/",
        }),
      ]),
    });
    expect(found(r.seen)).toMatchObject({ id: "t1_zzz" });
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/me",
      "GET /user/tester_one/comments",
    ]);
  });

  it("comment: a cut list that does not reach the send is unclear", async () => {
    const kids = Array.from({ length: 25 }, (_, i) =>
      child({
        name: `t1_k${i}`,
        parent_id: "t3_other",
        body: `other words ${i}`,
        created_utc: sec(SENT) + 60,
      }),
    );
    const r = await run("reddit", "POST", "/api/comment", THREAD, {
      ...ME,
      "GET /user/tester_one/comments": listing(kids, "t1_k24"),
    });
    expect(r.seen.seen).toBe("unclear");
  });

  it("comment: the same words under another parent are not a find", async () => {
    const r = await run("reddit", "POST", "/api/comment", THREAD, {
      ...ME,
      "GET /user/tester_one/comments": listing([
        child({
          name: "t1_new",
          parent_id: "t3_other",
          body: THREAD.text,
          created_utc: sec(SENT),
        }),
        child({ name: "t1_old", parent_id: "t3_older", body: "earlier", created_utc: sec(OLD) }),
      ]),
    });
    expect(r.seen.seen).toBe("absent");
  });

  it("comment: no account name is unclear", async () => {
    const r = await run("reddit", "POST", "/api/comment", THREAD, { "GET /api/v1/me": {} });
    expect(r.seen.seen).toBe("unclear");
  });

  it("submit: found by title in that subreddit", async () => {
    const r = await run(
      "reddit",
      "POST",
      "/api/submit",
      { sr: "testsub", title: "A plain title for a post", kind: "self", text: "body" },
      {
        ...ME,
        "GET /user/tester_one/submitted": listing([
          child({
            name: "t3_new1",
            subreddit: "TestSub",
            title: "A plain title for a post",
            created_utc: sec(SENT),
            permalink: "/r/testsub/comments/new1/a_plain_title/",
          }),
        ]),
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "t3_new1" });
  });

  it("submit: the same title in another subreddit is absent", async () => {
    const r = await run(
      "reddit",
      "POST",
      "/api/submit",
      { sr: "testsub", title: "A plain title for a post", kind: "self", text: "body" },
      {
        ...ME,
        "GET /user/tester_one/submitted": listing([
          child({
            name: "t3_x",
            subreddit: "elsewhere",
            title: "A plain title for a post",
            created_utc: sec(SENT),
          }),
        ]),
      },
    );
    expect(r.seen.seen).toBe("absent");
  });

  it("compose: found in the sent box to that person", async () => {
    const r = await run(
      "reddit",
      "POST",
      "/api/compose",
      { to: "u/someone_else", subject: "Hello there", text: "A short note for you." },
      {
        "GET /message/sent": listing([
          {
            kind: "t4",
            data: {
              name: "t4_m1",
              id: "m1",
              dest: "someone_else",
              body: "A short note for you.",
              created_utc: sec(SENT),
            },
          },
        ]),
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "t4_m1" });
  });

  it("compose: the same note to another person is absent", async () => {
    const r = await run(
      "reddit",
      "POST",
      "/api/compose",
      { to: "someone_else", subject: "Hello there", text: "A short note for you." },
      {
        "GET /message/sent": listing([
          {
            kind: "t4",
            data: {
              name: "t4_m2",
              id: "m2",
              dest: "third_one",
              body: "A short note for you.",
              created_utc: sec(SENT),
            },
          },
        ]),
      },
    );
    expect(r.seen.seen).toBe("absent");
  });
});

describe("tiktok", () => {
  const LIST = "POST /v2/video/list/";
  const video = (title: string, at: string) => ({
    id: "7000000000000000001",
    title,
    create_time: sec(at),
    share_url: "https://www.tiktok.com/@x/video/7000000000000000001",
  });
  const INIT = {
    post_info: { title: "A clip about caching", privacy_level: "PUBLIC_TO_EVERYONE" },
    source_info: { source: "PULL_FROM_URL", video_url: "https://example.com/a.mp4" },
  };
  const WEB = { caption: "A clip about caching", file: "/tmp/a.mp4" };

  for (const [name, path, raw] of [
    ["API publish", "/v2/post/publish/video/init/", INIT],
    ["web post", "/web/posts", WEB],
  ] as const) {
    it(`${name}: the video in the list is found, read by POST`, async () => {
      const r = await run("tiktok", "POST", path, raw, {
        [LIST]: { data: { videos: [video("A clip about caching", SENT)], has_more: false } },
      });
      expect(found(r.seen)).toMatchObject({ id: "7000000000000000001" });
      expect(r.calls[0]).toMatchObject({ method: "POST", path: "/v2/video/list/" });
    });

    it(`${name}: an empty list is unclear, never absent`, async () => {
      const r = await run("tiktok", "POST", path, raw, {
        [LIST]: { data: { videos: [], has_more: false } },
      });
      expect(r.seen.seen).toBe("unclear");
    });

    it(`${name}: a list of older videos is still unclear`, async () => {
      const r = await run("tiktok", "POST", path, raw, {
        [LIST]: { data: { videos: [video("Something else", OLD)], has_more: true } },
      });
      expect(r.seen.seen).toBe("unclear");
    });
  }

  it("API publish without a title has nothing to find it by", async () => {
    const r = await run(
      "tiktok",
      "POST",
      "/v2/post/publish/video/init/",
      { post_info: { privacy_level: "SELF_ONLY" }, source_info: INIT.source_info },
      {},
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("reply: found when the page marks our reply under that comment", async () => {
    const path = "/web/videos/{videoId}/comments/{commentId}/replies";
    const body = { videoId: "7000000000000000001", commentId: "c1", text: "Thanks for asking!" };
    const reads = (rows: unknown[]) => ({
      "GET /v2/user/info/": { data: { user: { display_name: "Tester" } } },
      "GET /web/videos/7000000000000000001/comments": { comments: rows },
    });
    const ours = { id: "r1", text: "Thanks for asking!", at: SENT, parentId: "c1", creator: true };
    expect(found((await run("tiktok", "POST", path, body, reads([ours]))).seen)).toMatchObject({
      id: "r1",
    });
    // A top-level comment with the same words is not a reply.
    const top = { ...ours, id: "c2", parentId: "" };
    expect((await run("tiktok", "POST", path, body, reads([top]))).seen.seen).toBe("unclear");
  });
});

describe("x", () => {
  const POST = "POST";
  it("post: found in the account's posts", async () => {
    const r = await run(
      "x",
      POST,
      "/2/tweets",
      { text: "Caching beats guessing. https://example.com/a" },
      {
        "GET /2/users/me": { data: { id: "123" } },
        "GET /2/users/123/tweets": {
          data: [
            {
              id: "900",
              text: "Caching beats guessing. https://t.co/abcd",
              created_at: SENT,
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "900", url: "https://x.com/i/status/900" });
  });

  it("post: a list that does not reach the send is unclear", async () => {
    const r = await run(
      "x",
      POST,
      "/2/tweets",
      { text: "Caching beats guessing." },
      {
        "GET /2/users/me": { data: { id: "123" } },
        "GET /2/users/123/tweets": { data: [{ id: "901", text: "Newer words", created_at: SENT }] },
      },
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("post: a list that reaches back past the send is absent", async () => {
    const r = await run(
      "x",
      POST,
      "/2/tweets",
      { text: "Caching beats guessing." },
      {
        "GET /2/users/me": { data: { id: "123" } },
        "GET /2/users/123/tweets": { data: [{ id: "88", text: "Old words", created_at: OLD }] },
      },
    );
    expect(r.seen.seen).toBe("absent");
  });

  it("reply: search in the thread finds it, and the post replied to is not it", async () => {
    const r = await run(
      "x",
      POST,
      "/2/tweets",
      { text: "Agreed, and here is why.", reply: { in_reply_to_tweet_id: "555" } },
      {
        "GET /2/tweets/search/recent": {
          data: [
            { id: "555", text: "Agreed, and here is why.", created_at: SENT },
            { id: "556", text: "Agreed, and here is why.", created_at: SENT },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "556" });
  });

  it("reply: an empty search is unclear, never absent (search lags)", async () => {
    const r = await run(
      "x",
      POST,
      "/2/tweets",
      { text: "Agreed, and here is why.", reply: { in_reply_to_tweet_id: "555" } },
      { "GET /2/tweets/search/recent": { data: [] } },
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("a post of media alone has no words to look for", async () => {
    const r = await run("x", POST, "/2/tweets", { media: { media_ids: ["1"] } }, {});
    expect(r.seen.seen).toBe("unclear");
  });
});

describe("linkedin", () => {
  const ORG = "urn:li:person:abc123";
  it("post: found in the author's newest posts", async () => {
    const r = await run(
      "linkedin",
      "POST",
      "/rest/posts",
      { author: ORG, commentary: "A note on caching." },
      {
        "GET /rest/posts": {
          elements: [
            {
              id: "urn:li:share:1",
              commentary: "A note on caching.",
              publishedAt: Date.parse(SENT),
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({
      id: "urn:li:share:1",
      url: "https://www.linkedin.com/feed/update/urn:li:share:1/",
    });
  });

  it("post: a short list of older posts is unclear (it is cut at a count)", async () => {
    const r = await run(
      "linkedin",
      "POST",
      "/rest/posts",
      { author: ORG, commentary: "A note on caching." },
      {
        "GET /rest/posts": {
          elements: [{ id: "urn:li:share:0", commentary: "Older", publishedAt: Date.parse(SENT) }],
        },
      },
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("connect: pending or connected is found, none is absent", async () => {
    const path = "/in/{vanity}/connect";
    const rel = (relationship: string) => ({
      "GET /in/some-person/relationship": { relationship },
    });
    expect(
      (await run("linkedin", "POST", path, { vanity: "some-person" }, rel("pending"))).seen.seen,
    ).toBe("found");
    expect(
      (await run("linkedin", "POST", path, { vanity: "some-person" }, rel("connected"))).seen.seen,
    ).toBe("found");
    expect(
      (await run("linkedin", "POST", path, { vanity: "some-person" }, rel("none"))).seen.seen,
    ).toBe("absent");
    expect(
      (await run("linkedin", "POST", path, { vanity: "some-person" }, rel("?"))).seen.seen,
    ).toBe("unclear");
  });

  it("withdraw: none is found, pending is absent", async () => {
    const path = "/in/{vanity}/withdraw";
    const rel = (relationship: string) => ({
      "GET /in/some-person/relationship": { relationship },
    });
    expect(
      (await run("linkedin", "POST", path, { vanity: "some-person" }, rel("none"))).seen.seen,
    ).toBe("found");
    expect(
      (await run("linkedin", "POST", path, { vanity: "some-person" }, rel("pending"))).seen.seen,
    ).toBe("absent");
    expect(
      (await run("linkedin", "POST", path, { vanity: "some-person" }, rel("connected"))).seen.seen,
    ).toBe("unclear");
  });

  it("message: our last message to that person is found; theirs is not", async () => {
    const path = "/in/{vanity}/message";
    const mine = await run(
      "linkedin",
      "POST",
      path,
      { vanity: "some-person", text: "Thanks for connecting, glad to be in touch." },
      {
        "GET /messaging": {
          conversations: [
            {
              vanity: "some-person",
              url: "https://www.linkedin.com/messaging/thread/1/",
              preview: "You: Thanks for connecting, glad to be in touch.",
            },
          ],
        },
      },
    );
    expect(found(mine.seen)).toBeTruthy();
    const theirs = await run(
      "linkedin",
      "POST",
      path,
      { vanity: "some-person", text: "Thanks for connecting, glad to be in touch." },
      {
        "GET /messaging": {
          conversations: [
            {
              vanity: "some-person",
              url: "u",
              preview: "Thanks for connecting, glad to be in touch.",
            },
          ],
        },
      },
    );
    expect(theirs.seen.seen).toBe("unclear");
  });

  it("comment: a member's comment under that parent is found by name", async () => {
    const post = "urn:li:activity:111";
    const r = await run(
      "linkedin",
      "POST",
      "/rest/socialActions/{urn}/comments",
      {
        urn: post,
        actor: ORG,
        message: { text: "Well said, thanks for sharing it." },
      },
      {
        "GET /v2/userinfo": { name: "Test Person" },
        [`GET /rest/socialActions/${encodeURIComponent(post)}/comments`]: {
          elements: [
            {
              actorName: "Test Person",
              message: { text: "Well said, thanks for sharing it." },
              created: { time: Date.parse(SENT) },
              commentUrn: "urn:li:comment:(urn:li:activity:111,222)",
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "urn:li:comment:(urn:li:activity:111,222)" });
  });

  it("comment: the browser read names the viewer, so no userinfo read", async () => {
    const post = "urn:li:activity:111";
    const r = await run(
      "linkedin",
      "POST",
      "/rest/socialActions/{urn}/comments",
      { urn: post, actor: ORG, message: { text: "Well said, thanks for sharing it." } },
      {
        [`GET /rest/socialActions/${encodeURIComponent(post)}/comments`]: {
          viewer: "Test Person",
          elements: [
            {
              actorName: "Test Person",
              message: { text: "Well said, thanks for sharing it." },
              created: { time: Date.parse(SENT) },
              commentUrn: "urn:li:comment:(urn:li:activity:111,222)",
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "urn:li:comment:(urn:li:activity:111,222)" });
    expect(r.calls).toHaveLength(1);
  });

  it("comment: the same words by another person are not ours", async () => {
    const post = "urn:li:activity:111";
    const r = await run(
      "linkedin",
      "POST",
      "/rest/socialActions/{urn}/comments",
      {
        urn: post,
        actor: ORG,
        message: { text: "Well said, thanks for sharing it." },
      },
      {
        "GET /v2/userinfo": { name: "Test Person" },
        [`GET /rest/socialActions/${encodeURIComponent(post)}/comments`]: {
          elements: [
            {
              actorName: "Someone Else",
              message: { text: "Well said, thanks for sharing it." },
              created: { time: Date.parse(SENT) },
              commentUrn: "urn:li:comment:(urn:li:activity:111,333)",
            },
          ],
        },
      },
    );
    // A comments read is ranked and never complete, so this is unclear, not absent.
    expect(r.seen.seen).toBe("unclear");
  });
});

describe("youtube", () => {
  const CH = {
    "GET /youtube/v3/channels": {
      items: [{ id: "UCmine", contentDetails: { relatedPlaylists: { uploads: "UUmine" } } }],
    },
  };
  it("upload: found in the uploads list", async () => {
    const r = await run(
      "youtube",
      "POST",
      "/upload/youtube/v3/videos",
      { snippet: { title: "A talk on caching" }, file: "/tmp/a.mp4" },
      {
        ...CH,
        "GET /youtube/v3/playlistItems": {
          items: [
            {
              snippet: {
                title: "A talk on caching",
                publishedAt: SENT,
                resourceId: { videoId: "vid1" },
              },
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({
      id: "vid1",
      url: "https://www.youtube.com/watch?v=vid1",
    });
  });

  it("upload: an empty uploads list is unclear (the list lags)", async () => {
    const r = await run(
      "youtube",
      "POST",
      "/upload/youtube/v3/videos",
      { snippet: { title: "A talk on caching" }, file: "/tmp/a.mp4" },
      {
        ...CH,
        "GET /youtube/v3/playlistItems": { items: [] },
      },
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("comment: found by channel and words", async () => {
    const r = await run(
      "youtube",
      "POST",
      "/youtube/v3/commentThreads",
      {
        snippet: {
          videoId: "vid1",
          topLevelComment: { snippet: { textOriginal: "Great walk through." } },
        },
      },
      {
        ...CH,
        "GET /youtube/v3/commentThreads": {
          items: [
            {
              id: "ct1",
              snippet: {
                topLevelComment: {
                  id: "ct1",
                  snippet: {
                    textOriginal: "Great walk through.",
                    publishedAt: SENT,
                    authorChannelId: { value: "UCmine" },
                  },
                },
              },
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "ct1" });
  });

  it("comment: the same words by another channel, read to the end, are absent", async () => {
    const r = await run(
      "youtube",
      "POST",
      "/youtube/v3/commentThreads",
      {
        snippet: {
          videoId: "vid1",
          topLevelComment: { snippet: { textOriginal: "Great walk through." } },
        },
      },
      {
        ...CH,
        "GET /youtube/v3/commentThreads": {
          items: [
            {
              id: "ct2",
              snippet: {
                topLevelComment: {
                  id: "ct2",
                  snippet: {
                    textOriginal: "Great walk through.",
                    publishedAt: SENT,
                    authorChannelId: { value: "UCother" },
                  },
                },
              },
            },
          ],
        },
      },
    );
    expect(r.seen.seen).toBe("absent");
  });

  it("reply: found under that parent", async () => {
    const r = await run(
      "youtube",
      "POST",
      "/youtube/v3/comments",
      {
        snippet: { parentId: "ct1", textOriginal: "Thanks, glad it helped." },
      },
      {
        ...CH,
        "GET /youtube/v3/comments": {
          items: [
            {
              id: "ct1.r1",
              snippet: {
                textOriginal: "Thanks, glad it helped.",
                publishedAt: SENT,
                authorChannelId: { value: "UCmine" },
              },
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "ct1.r1" });
  });
});

describe("meta", () => {
  const PAGE = "100000000000001";
  const posts = (rows: unknown[], next = false) => ({
    [`GET /${PAGE}/posts`]: { data: rows, ...(next ? { paging: { next: "https://x" } } : {}) },
  });
  const row = (message: string, at: string) => ({
    id: `${PAGE}_9`,
    message,
    created_time: at.replace("Z", "+0000"),
    permalink_url: "https://www.facebook.com/p/9",
  });

  it("feed: found in the Page's posts, with its id and link", async () => {
    const r = await run(
      "meta",
      "POST",
      "/{pageId}/feed",
      { pageId: PAGE, message: "A note on caching." },
      posts([row("A note on caching.", SENT)]),
    );
    expect(found(r.seen)).toMatchObject({ id: `${PAGE}_9`, url: "https://www.facebook.com/p/9" });
  });

  it("feed: not in a complete list is absent", async () => {
    const r = await run(
      "meta",
      "POST",
      "/{pageId}/feed",
      { pageId: PAGE, message: "A note on caching." },
      posts([row("Other", SENT)]),
    );
    expect(r.seen.seen).toBe("absent");
  });

  it("feed: a scheduled post never proves absent", async () => {
    const r = await run(
      "meta",
      "POST",
      "/{pageId}/feed",
      { pageId: PAGE, message: "A note on caching.", published: false },
      posts([]),
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("video: an empty list is unclear (it lists once processed)", async () => {
    const r = await run(
      "meta",
      "POST",
      "/{pageId}/videos",
      { pageId: PAGE, file_url: "https://example.com/a.mp4", description: "A clip." },
      posts([]),
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("Instagram publish: the container state decides", async () => {
    const at = (status_code: string) => ({ "GET /777": { status_code } });
    const body = { igUserId: "1784", creation_id: "777" };
    const path = "/{igUserId}/media_publish";
    expect((await run("meta", "POST", path, body, at("PUBLISHED"))).seen.seen).toBe("found");
    expect((await run("meta", "POST", path, body, at("EXPIRED"))).seen.seen).toBe("absent");
    expect((await run("meta", "POST", path, body, at("IN_PROGRESS"))).seen.seen).toBe("unclear");
  });

  it("Page comment reply: found by the Page's own id", async () => {
    const r = await run(
      "meta",
      "POST",
      "/{commentId}/comments",
      { pageId: PAGE, commentId: "55", message: "Thanks for asking." },
      {
        "GET /55/comments": {
          data: [
            {
              id: "56",
              message: "Thanks for asking.",
              from: { id: PAGE },
              created_time: SENT.replace("Z", "+0000"),
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "56" });
  });

  it("DM: found in the person's conversation, from the Page", async () => {
    const conv = (from: string) => ({
      data: [
        {
          messages: {
            data: [
              {
                id: "m1",
                message: "Here is the link you asked for.",
                from: { id: from },
                created_time: SENT.replace("Z", "+0000"),
              },
            ],
          },
        },
      ],
    });
    const r = await run(
      "meta",
      "POST",
      "/{pageId}/messages",
      {
        pageId: PAGE,
        recipient: { id: "999" },
        message: { text: "Here is the link you asked for." },
      },
      {
        [`GET /${PAGE}/conversations`]: conv(PAGE),
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "m1" });
  });

  it("DM: a private reply to a comment is never proved absent", async () => {
    const r = await run(
      "meta",
      "POST",
      "/{pageId}/messages",
      {
        pageId: PAGE,
        recipient: { comment_id: "55" },
        message: { text: "Here is the link you asked for." },
      },
      {
        [`GET /${PAGE}/conversations`]: { data: [] },
      },
    );
    expect(r.seen.seen).toBe("unclear");
  });
});

describe("instagram", () => {
  it("web post: found in the account's media", async () => {
    const r = await run(
      "instagram",
      "POST",
      "/web/posts",
      { caption: "A note on caching.", file: "/tmp/a.jpg" },
      {
        "GET /me": { user_id: "1784", username: "tester" },
        "GET /1784/media": {
          data: [
            {
              id: "m1",
              caption: "A note on caching.",
              timestamp: SENT.replace("Z", "+0000"),
              permalink: "https://www.instagram.com/p/xyz/",
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "m1", url: "https://www.instagram.com/p/xyz/" });
  });

  it("web post: an empty list is unclear (a video lists once processed)", async () => {
    const r = await run(
      "instagram",
      "POST",
      "/web/posts",
      { caption: "A note on caching.", file: "/tmp/a.jpg" },
      {
        "GET /me": { user_id: "1784", username: "tester" },
        "GET /1784/media": { data: [] },
      },
    );
    expect(r.seen.seen).toBe("unclear");
  });

  it("publish: the container state decides", async () => {
    const at = (status_code: string) => ({ "GET /containers/777": { status_code } });
    const path = "/{igUserId}/media_publish";
    const body = { igUserId: "1784", creation_id: "777" };
    expect((await run("instagram", "POST", path, body, at("PUBLISHED"))).seen.seen).toBe("found");
    expect((await run("instagram", "POST", path, body, at("ERROR"))).seen.seen).toBe("absent");
    expect((await run("instagram", "POST", path, body, at("FINISHED"))).seen.seen).toBe("unclear");
  });

  it("reply: found by our username", async () => {
    const r = await run(
      "instagram",
      "POST",
      "/{commentId}/replies",
      { commentId: "55", message: "Thanks for asking." },
      {
        "GET /me": { user_id: "1784", username: "Tester" },
        "GET /55/replies": {
          data: [
            {
              id: "56",
              text: "Thanks for asking.",
              username: "tester",
              timestamp: SENT.replace("Z", "+0000"),
            },
          ],
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "56" });
  });

  it("web comment: the page marks our top-level comment", async () => {
    const r = await run(
      "instagram",
      "POST",
      "/web/p/{shortcode}/comments",
      { shortcode: "Cxyz12", text: "Lovely shot." },
      {
        "GET /web/p/Cxyz12/comments": {
          viewer: "tester",
          comments: [
            {
              id: "c1",
              username: "tester",
              text: "Lovely shot.",
              at: SENT,
              parentId: "",
              mine: true,
            },
          ],
          more: false,
        },
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "c1" });
  });

  it("web comment: not in a complete list is absent; a partial list is unclear", async () => {
    const some = {
      viewer: "tester",
      comments: [
        { id: "c9", username: "other", text: "Nice", at: SENT, parentId: "", mine: false },
      ],
    };
    const path = "/web/p/{shortcode}/comments";
    const a = await run(
      "instagram",
      "POST",
      path,
      { shortcode: "Cxyz12", text: "Lovely shot." },
      { "GET /web/p/Cxyz12/comments": { ...some, more: false } },
    );
    expect(a.seen.seen).toBe("absent");
    const b = await run(
      "instagram",
      "POST",
      path,
      { shortcode: "Cxyz12", text: "Lovely shot." },
      { "GET /web/p/Cxyz12/comments": { ...some, more: true } },
    );
    expect(b.seen.seen).toBe("unclear");
  });
});

describe("threads", () => {
  it("publish: the container state decides", async () => {
    const at = (status: string) => ({ "GET /containers/777": { status } });
    const path = "/{userId}/threads_publish";
    const body = { userId: "1784", creation_id: "777" };
    expect((await run("threads", "POST", path, body, at("PUBLISHED"))).seen.seen).toBe("found");
    expect((await run("threads", "POST", path, body, at("EXPIRED"))).seen.seen).toBe("absent");
    expect((await run("threads", "POST", path, body, at("FINISHED"))).seen.seen).toBe("unclear");
  });
});

describe("gmail", () => {
  const raw = (to: string, subject: string) =>
    Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nbody`,
    ).toString("base64url");
  const meta = (to: string, subject: string, at: string) => ({
    internalDate: String(Date.parse(at)),
    payload: {
      headers: [
        { name: "To", value: to },
        { name: "Subject", value: subject },
      ],
    },
  });
  it("found by subject and recipient in Sent", async () => {
    const r = await run(
      "gmail",
      "POST",
      "/gmail/v1/users/me/messages/send",
      { raw: raw("Pat <pat@example.com>", "Quick question") },
      {
        "GET /gmail/v1/users/me/messages": { messages: [{ id: "g1" }] },
        "GET /gmail/v1/users/me/messages/g1": meta("pat@example.com", "Quick question", SENT),
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "g1" });
  });

  it("the same subject to another person is not it", async () => {
    const r = await run(
      "gmail",
      "POST",
      "/gmail/v1/users/me/messages/send",
      { raw: raw("pat@example.com", "Quick question") },
      {
        "GET /gmail/v1/users/me/messages": { messages: [{ id: "g2" }] },
        "GET /gmail/v1/users/me/messages/g2": meta("sam@example.com", "Quick question", SENT),
      },
    );
    expect(r.seen.seen).toBe("absent");
  });
});

describe("outlook", () => {
  const ME = { "GET /me": { mail: "me@example.com" } };
  const mail = (o: Record<string, unknown>) => ({ "GET /me/messages": { value: [o] } });
  const sent = {
    message: {
      subject: "Quick question",
      body: { content: "hi" },
      toRecipients: [{ emailAddress: { address: "pat@example.com" } }],
    },
  };
  it("sendMail: found in the mailbox from us to them", async () => {
    const r = await run("outlook", "POST", "/me/sendMail", sent, {
      ...ME,
      ...mail({
        id: "o1",
        subject: "Quick question",
        from: { emailAddress: { address: "me@example.com" } },
        toRecipients: [{ emailAddress: { address: "pat@example.com" } }],
        sentDateTime: SENT,
      }),
    });
    expect(found(r.seen)).toMatchObject({ id: "o1" });
  });

  it("sendMail: not saved to Sent is unclear", async () => {
    const r = await run("outlook", "POST", "/me/sendMail", { ...sent, saveToSentItems: false }, ME);
    expect(r.seen.seen).toBe("unclear");
  });

  it("reply: found in the same conversation", async () => {
    const r = await run(
      "outlook",
      "POST",
      "/me/messages/{id}/reply",
      { id: "orig", comment: "Thanks, see you then." },
      {
        ...ME,
        "GET /me/messages/orig": { conversationId: "conv1" },
        ...mail({
          id: "o2",
          bodyPreview: "Thanks, see you then.\r\n\r\nFrom: Pat",
          from: { emailAddress: { address: "me@example.com" } },
          toRecipients: [],
          conversationId: "conv1",
          sentDateTime: SENT,
        }),
      },
    );
    expect(found(r.seen)).toMatchObject({ id: "o2" });
  });
});

describe("sentAs", () => {
  const sentAs = (site: string, method: string, path: string, answer: unknown) =>
    routeOf(site, method, path).sentAs?.(answer as never);

  it("reddit comment and submit answer fullnames and links", () => {
    expect(
      sentAs("reddit", "POST", "/api/comment", {
        json: {
          errors: [],
          data: {
            things: [
              { kind: "t1", data: { name: "t1_aa", id: "aa", permalink: "/r/x/comments/1/t/aa/" } },
            ],
          },
        },
      }),
    ).toEqual({ id: "t1_aa", url: "https://www.reddit.com/r/x/comments/1/t/aa/" });
    expect(
      sentAs("reddit", "POST", "/api/submit", {
        json: {
          errors: [],
          data: { name: "t3_bb", id: "bb", url: "https://www.reddit.com/r/x/comments/bb/t/" },
        },
      }),
    ).toEqual({ id: "t3_bb", url: "https://www.reddit.com/r/x/comments/bb/t/" });
  });

  it("x tweet", () => {
    expect(sentAs("x", "POST", "/2/tweets", { data: { id: "42", text: "t" } })).toEqual({
      id: "42",
      url: "https://x.com/i/status/42",
    });
  });

  it("linkedin post: the API id and the browser link", () => {
    expect(sentAs("linkedin", "POST", "/rest/posts", { id: "urn:li:share:1" })).toEqual({
      id: "urn:li:share:1",
      url: "https://www.linkedin.com/feed/update/urn:li:share:1/",
    });
    expect(
      sentAs("linkedin", "POST", "/rest/posts", {
        id: "urn:li:share:1",
        url: "https://www.linkedin.com/feed/update/urn:li:share:1/",
      })?.url,
    ).toBe("https://www.linkedin.com/feed/update/urn:li:share:1/");
  });

  it("tiktok: the publish id, and the web post id and link", () => {
    expect(
      sentAs("tiktok", "POST", "/v2/post/publish/video/init/", { data: { publish_id: "p1" } }),
    ).toEqual({ id: "p1", url: null });
    expect(
      sentAs("tiktok", "POST", "/web/posts", {
        id: "7000",
        url: "https://www.tiktok.com/@x/video/7000",
      }),
    ).toEqual({
      id: "7000",
      url: "https://www.tiktok.com/@x/video/7000",
    });
  });

  it("youtube video, comment and community post", () => {
    expect(sentAs("youtube", "POST", "/upload/youtube/v3/videos", { id: "vid1" })).toEqual({
      id: "vid1",
      url: "https://www.youtube.com/watch?v=vid1",
    });
    expect(
      sentAs("youtube", "POST", "/youtube/v3/commentThreads", {
        id: "ct1",
        snippet: { videoId: "vid1" },
      }),
    ).toEqual({
      id: "ct1",
      url: "https://www.youtube.com/watch?v=vid1&lc=ct1",
    });
  });

  it("meta feed post", () => {
    expect(sentAs("meta", "POST", "/{pageId}/feed", { id: "100_9" })).toEqual({
      id: "100_9",
      url: "https://www.facebook.com/100_9",
    });
  });

  it("a malformed answer gives null, never a throw", () => {
    expect(sentAs("x", "POST", "/2/tweets", null)).toEqual({ id: null, url: null });
    expect(sentAs("reddit", "POST", "/api/comment", "oops")).toEqual({ id: null, url: null });
  });
});
