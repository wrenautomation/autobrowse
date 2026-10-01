import { describe, expect, it } from "vitest";
import type { FlowPage } from "../src/browser/flow.js";
import {
  redditComment,
  redditMessage,
  redditRead,
  redditSubmit,
} from "../src/browser/flows/reddit.js";
import { httpClient } from "../src/clients/http.js";
import { memorySink } from "../src/deps/sink.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryCaps } from "../src/sites/caps.js";
import { REDDIT_ORIGIN, reddit, SITES, SiteError, siteFacade } from "../src/sites/index.js";
import { fakeBrowser, fakeFetch } from "./fakes.js";

const routeOf = (method: string, path: string) => {
  const r = reddit.routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`no route ${method} ${path}`);
  return r;
};
const ok = (method: string, path: string, input: unknown) =>
  routeOf(method, path).request.safeParse(input).success;
const parsed = (method: string, path: string, input: unknown) => {
  const r = routeOf(method, path).request.safeParse(input);
  if (!r.success) throw new Error(r.error.message);
  return r.data as Record<string, unknown>;
};
const legInput = (method: string, path: string, input: unknown) => {
  const r = routeOf(method, path);
  const data = parsed(method, path, input) as never;
  return r.browser?.input ? r.browser.input(data, () => undefined) : data;
};

const SUBMIT = ["POST", "/api/submit"] as const;
const COMMENT = ["POST", "/api/comment"] as const;
const self = { sr: "startups", title: "Hello", kind: "self" };

describe("reddit site", () => {
  it("is served, open (no client), every route a browser leg on a reddit flow", () => {
    expect(SITES).toContain(reddit);
    expect(reddit.origin).toBe(REDDIT_ORIGIN);
    expect(reddit.auth).toEqual({ open: true });
    expect(reddit.setup).toEqual([]);
    expect(reddit.routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/me",
      "GET /user/{username}/submitted",
      "GET /user/{username}/comments",
      "GET /user/{username}/about",
      "GET /r/{subreddit}/new",
      "GET /r/{subreddit}/search",
      "GET /search",
      "GET /message/{where}",
      "GET /api/info",
      "GET /comments/{article}",
      "GET /r/{subreddit}/about/rules",
      "POST /api/submit",
      "POST /api/comment",
      "POST /api/compose",
    ]);
    for (const r of reddit.routes) {
      expect(r.api).toBeUndefined();
      expect(r.browser && "flow" in r.browser ? r.browser.flow : null).toBe(
        r.method === "GET"
          ? "reddit/read"
          : r.path === "/api/submit"
            ? "reddit/submit"
            : r.path === "/api/compose"
              ? "reddit/message"
              : "reddit/comment",
      );
    }
    expect(BROWSER_FLOWS["reddit/read"]).toBe(redditRead);
    expect(BROWSER_FLOWS["reddit/submit"]).toBe(redditSubmit);
    expect(BROWSER_FLOWS["reddit/comment"]).toBe(redditComment);
    expect(BROWSER_FLOWS["reddit/message"]).toBe(redditMessage);
  });

  it("writes are irreversible and metered per bucket; reads are one read each", () => {
    for (const r of reddit.routes) {
      const write = r.method === "POST";
      expect(r.irreversible ?? false).toBe(write);
    }
    expect(routeOf(...SUBMIT).meter?.(parsed(...SUBMIT, self) as never)).toEqual({ posts: 1 });
    expect(
      routeOf(...COMMENT).meter?.(parsed(...COMMENT, { thing_id: "t3_a", text: "hi" }) as never),
    ).toEqual({ comments: 1 });
    expect(
      routeOf("POST", "/api/compose").meter?.(
        parsed("POST", "/api/compose", { to: "someone", subject: "hi", text: "hello" }) as never,
      ),
    ).toEqual({ messages: 1 });
    for (const r of reddit.routes.filter((x) => x.method === "GET"))
      expect(r.meter?.({} as never)).toEqual({ reads: 1 });
  });

  it("is capped and paced like a person", () => {
    expect(reddit.caps).toEqual({ reads: 300, posts: 3, comments: 20, messages: 5 });
    expect(reddit.pace).toEqual({ gapMs: 20_000, jitterMs: 40_000 });
  });
});

describe("reddit request shapes", () => {
  it("submit: sr is a subreddit (r/ allowed) or the u_/u/ profile", () => {
    for (const sr of [
      "startups",
      "r/startups",
      "AskReddit",
      "ab",
      "a".repeat(21),
      "u_WrenAutomation",
      "u/WrenAutomation",
      "u_wren-auto",
    ])
      expect(ok(...SUBMIT, { ...self, sr }), sr).toBe(true);
    for (const sr of [
      "a",
      "a".repeat(22),
      "r/a",
      "/r/startups",
      "R/startups",
      "start ups",
      "start-ups",
      "u/ab",
      "u/Wren Automation",
      "",
    ])
      expect(ok(...SUBMIT, { ...self, sr }), sr).toBe(false);
  });

  it("submit: a title of 1 to 300, a known kind, a link needs its url", () => {
    expect(ok(...SUBMIT, { ...self, title: "x".repeat(300) })).toBe(true);
    expect(ok(...SUBMIT, { ...self, title: "x".repeat(301) })).toBe(false);
    expect(ok(...SUBMIT, { ...self, title: "" })).toBe(false);
    expect(ok(...SUBMIT, { ...self, kind: "image" })).toBe(false);
    expect(ok(...SUBMIT, { ...self, kind: "link" })).toBe(false);
    expect(ok(...SUBMIT, { ...self, kind: "link", url: "not a url" })).toBe(false);
    expect(ok(...SUBMIT, { ...self, kind: "link", url: "https://wrenautomation.com" })).toBe(true);
    expect(ok(...SUBMIT, { ...self, text: "x".repeat(40_001) })).toBe(false);
    expect(ok(...SUBMIT, { ...self, api_type: "xml" })).toBe(false);
    expect(parsed(...SUBMIT, self)).toMatchObject({ api_type: "json", sendreplies: true });
  });

  it("submit: sendreplies false stays false", () => {
    expect(parsed(...SUBMIT, { ...self, sendreplies: false }).sendreplies).toBe(false);
  });

  it('submit: sendreplies "false" (a form value) stays false', () => {
    expect(parsed(...SUBMIT, { ...self, sendreplies: "false" }).sendreplies).toBe(false);
  });

  it("comment: thing_id is t1_ or t3_, text 1 to 10000", () => {
    for (const thing_id of ["t1_abc", "t3_abc123"])
      expect(ok(...COMMENT, { thing_id, text: "hi" }), thing_id).toBe(true);
    for (const thing_id of ["t2_abc", "t5_abc", "abc", "t3_", "t3_ABC", "t3_a,t1_b"])
      expect(ok(...COMMENT, { thing_id, text: "hi" }), thing_id).toBe(false);
    expect(ok(...COMMENT, { thing_id: "t3_a", text: "" })).toBe(false);
    expect(ok(...COMMENT, { thing_id: "t3_a", text: "x".repeat(10_000) })).toBe(true);
    expect(ok(...COMMENT, { thing_id: "t3_a", text: "x".repeat(10_001) })).toBe(false);
  });

  it("reads: usernames, fullnames, post ids, subreddits; limits coerced and bounded", () => {
    const sub = ["GET", "/user/{username}/submitted"] as const;
    expect(parsed(...sub, { username: "WrenAutomation", limit: "5" })).toEqual({
      username: "WrenAutomation",
      limit: 5,
      sort: "new",
    });
    expect(ok(...sub, { username: "ab" })).toBe(false);
    expect(ok(...sub, { username: "a".repeat(21) })).toBe(false);
    expect(ok(...sub, { username: "Wren", limit: "101" })).toBe(false);
    expect(ok(...sub, { username: "Wren", limit: "0" })).toBe(false);
    expect(ok(...sub, { username: "Wren", sort: "rising" })).toBe(false);

    const info = ["GET", "/api/info"] as const;
    expect(ok(...info, { id: "t3_abc,t1_def" })).toBe(true);
    for (const id of ["t3_abc,", "abc", "t7_abc", "t3_abc t1_def", ""])
      expect(ok(...info, { id }), id).toBe(false);

    const comments = ["GET", "/comments/{article}"] as const;
    expect(parsed(...comments, { article: "abc123" })).toEqual({
      article: "abc123",
      limit: 25,
      depth: 1,
      sort: "new",
    });
    expect(ok(...comments, { article: "t3_abc" })).toBe(false);
    expect(ok(...comments, { article: "abc", depth: "11" })).toBe(false);

    const rules = ["GET", "/r/{subreddit}/about/rules"] as const;
    expect(ok(...rules, { subreddit: "startups" })).toBe(true);
    expect(ok(...rules, { subreddit: "s" })).toBe(false);
    expect(ok(...rules, { subreddit: "r/startups" })).toBe(false);
  });
});

describe("reddit browser leg inputs", () => {
  it("each read becomes the read flow's {path, query}, undefined query fields dropped", () => {
    expect(legInput("GET", "/api/v1/me", {})).toEqual({ path: "/api/me" });
    expect(legInput("GET", "/user/{username}/submitted", { username: "WrenAutomation" })).toEqual({
      path: "/user/WrenAutomation/submitted",
      query: { limit: 25, sort: "new" },
    });
    expect(
      legInput("GET", "/user/{username}/submitted", { username: "Wren", after: "t3_x", limit: 3 }),
    ).toEqual({ path: "/user/Wren/submitted", query: { limit: 3, sort: "new", after: "t3_x" } });
    expect(legInput("GET", "/api/info", { id: "t3_a,t1_b" })).toEqual({
      path: "/api/info",
      query: { id: "t3_a,t1_b" },
    });
    expect(legInput("GET", "/comments/{article}", { article: "abc" })).toEqual({
      path: "/comments/abc",
      query: { limit: 25, depth: 1, sort: "new" },
    });
    expect(legInput("GET", "/r/{subreddit}/about/rules", { subreddit: "startups" })).toEqual({
      path: "/r/startups/about/rules",
    });
  });

  it("every read route's leg input is a path the read flow serves", async () => {
    const samples: Record<string, Record<string, unknown>> = {
      "/api/v1/me": {},
      "/user/{username}/submitted": { username: "WrenAutomation" },
      "/user/{username}/comments": { username: "WrenAutomation" },
      "/user/{username}/about": { username: "WrenAutomation" },
      "/r/{subreddit}/new": { subreddit: "startups" },
      "/r/{subreddit}/search": { subreddit: "startups", q: "hiring" },
      "/search": { q: "recruiting agency" },
      "/message/{where}": { where: "unread" },
      "/api/info": { id: "t3_a" },
      "/comments/{article}": { article: "abc" },
      "/r/{subreddit}/about/rules": { subreddit: "startups" },
    };
    for (const r of reddit.routes.filter((x) => x.method === "GET")) {
      const input = legInput("GET", r.path, samples[r.path]) as { path: string };
      let served = true;
      // A page whose evaluate answers 404 without running anything: only the READS match matters.
      const fp = {
        url: () => "https://old.reddit.com/",
        open: async () => {},
        page: { evaluate: async () => ({ status: 404, body: null }) },
      } as unknown as FlowPage;
      await redditRead.run(fp, input as never).catch((e: Error) => {
        if (/not a read this flow serves/.test(e.message)) served = false;
      });
      expect(served, r.path).toBe(true);
    }
  });

  it("submit strips r/ and passes the rest; comment passes the request as is", () => {
    expect(legInput(...SUBMIT, { ...self, sr: "r/startups", text: "b" })).toEqual({
      api_type: "json",
      sr: "startups",
      title: "Hello",
      kind: "self",
      text: "b",
      sendreplies: true,
    });
    expect(legInput(...SUBMIT, { ...self, sr: "u_WrenAutomation" })).toMatchObject({
      sr: "u_WrenAutomation",
    });
    expect(routeOf(...COMMENT).browser?.input).toBeUndefined();
  });

  it("compose strips u/ off the recipient", () => {
    expect(
      legInput("POST", "/api/compose", { to: "u/Someone", subject: "hi", text: "hello" }),
    ).toEqual({ to: "Someone", subject: "hi", text: "hello" });
  });
});

describe("reddit through the facade", () => {
  const noon = Date.UTC(2026, 8, 29, 12);
  function facade(pace = reddit.pace) {
    const calls: string[] = [];
    const inputs: unknown[] = [];
    const browser = fakeBrowser(calls);
    browser.on(redditSubmit, async (i) => {
      inputs.push(i);
      return { json: { errors: [], data: { id: "a", name: "t3_a", url: "u" } } };
    });
    browser.on(redditComment, async (i) => {
      inputs.push(i);
      return { json: { errors: [], data: { things: [] } } };
    });
    browser.on(redditRead, async (i) => {
      inputs.push(i);
      return { kind: "Listing" };
    });
    const caps = memoryCaps(() => noon);
    const sleeps: number[] = [];
    const sites = siteFacade([{ ...reddit, ...(pace ? { pace } : {}) }], {
      http: httpClient({ fetch: fakeFetch(() => ({ status: 500 })).fetch }),
      env: () => undefined,
      sink: memorySink(),
      runner: browser,
      flow: (n) => BROWSER_FLOWS[n] ?? null,
      caps,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    return { sites, inputs, caps, sleeps };
  }

  it("lists every route as a browser leg, writes flagged irreversible", async () => {
    const { sites } = facade();
    const row = await sites.status("reddit");
    expect(row.authed).toBe(true);
    expect(row.routes.every((r) => r.via === "browser")).toBe(true);
    expect(row.routes.filter((r) => r.irreversible).map((r) => r.path)).toEqual([
      "/api/submit",
      "/api/comment",
      "/api/compose",
    ]);
  });

  it("a read takes its query off the path and reaches the read flow", async () => {
    const { sites, inputs } = facade({ gapMs: 0 });
    await sites.call("reddit", "GET", "/user/WrenAutomation/submitted?limit=5&sort=top", {});
    expect(inputs).toEqual([
      { path: "/user/WrenAutomation/submitted", query: { limit: 5, sort: "top" } },
    ]);
  });

  it("a submit reaches the flow with r/ stripped; a bad one is a 400 and never runs", async () => {
    const { sites, inputs } = facade({ gapMs: 0 });
    await sites.call("reddit", "POST", "/api/submit", { ...self, sr: "r/startups" });
    expect(inputs).toMatchObject([{ sr: "startups", title: "Hello", kind: "self" }]);
    const err = await sites
      .call("reddit", "POST", "/api/submit", { ...self, kind: "link" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteError);
    expect(err).toMatchObject({
      status: 400,
      message: expect.stringMatching(/link post needs url/),
    });
    expect(inputs).toHaveLength(1);
  });

  it("three posts a day, then 429 without running the flow; comments have their own cap", async () => {
    const { sites, inputs, caps } = facade({ gapMs: 0 });
    for (let i = 0; i < 3; i++) await sites.call("reddit", "POST", "/api/submit", self);
    const err = await sites.call("reddit", "POST", "/api/submit", self).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(inputs).toHaveLength(3);
    expect(caps.today()["reddit|reddit|posts"]).toBe(3);
    // Comments are not spent by posts.
    await sites.call("reddit", "POST", "/api/comment", { thing_id: "t3_a", text: "hi" });
    expect(inputs).toHaveLength(4);
    for (let i = 1; i < 20; i++)
      await sites.call("reddit", "POST", "/api/comment", { thing_id: "t3_a", text: "hi" });
    await expect(
      sites.call("reddit", "POST", "/api/comment", { thing_id: "t3_a", text: "hi" }),
    ).rejects.toMatchObject({ status: 429 });
    expect(inputs).toHaveLength(23);
  });

  it("paced: a second call at the same instant waits at least the gap", async () => {
    const { sites, sleeps } = facade();
    await sites.call("reddit", "GET", "/api/v1/me", {});
    await sites.call("reddit", "GET", "/api/v1/me", {});
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(20_000);
    expect(sleeps[0]).toBeLessThanOrEqual(60_000);
  });
});
