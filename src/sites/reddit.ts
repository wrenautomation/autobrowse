/**
 * Reddit under its Data API's shapes (oauth.reddit.com): the account, its
 * submissions, a thing by id, a post's comments, a subreddit's rules, a
 * submit and a comment. Reddit refused Wren an API client on 2026-09-29, so
 * every route is a browser leg on old.reddit.com (flows in
 * `browser/flows/reddit.ts`); an `api` leg joins a route if a client is ever
 * granted. Reddit bot-checks a datacenter IP, so these legs run on a machine
 * with a home IP (the Mac's desk worker, `src/app/desk.ts`), paced and
 * capped per account like a person posting.
 */
import { z } from "zod";
import { route, type SiteApi } from "./types.js";

export const REDDIT_ORIGIN = "https://oauth.reddit.com";

const limit = z.coerce.number().int().min(1).max(100).default(25);
const query = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<
    string,
    string | number
  >;

const submitted = z.object({
  username: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/, "a Reddit username"),
  limit,
  sort: z.enum(["new", "hot", "top", "controversial"]).default("new"),
  after: z.string().optional(),
});
const info = z.object({ id: z.string().regex(/^(t[1-6]_[a-z0-9]+)(,t[1-6]_[a-z0-9]+)*$/) });
const comments = z.object({
  article: z.string().regex(/^[a-z0-9]{1,12}$/, "a post id without t3_"),
  limit,
  depth: z.coerce.number().int().min(1).max(10).default(1),
  sort: z.enum(["confidence", "top", "new", "controversial", "old", "qa"]).default("new"),
});
/** A form value ("true"/"false") or a boolean; `z.coerce` would read "false" as true. */
const flag = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
const rules = z.object({ subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/) });
const submit = z
  .object({
    api_type: z.literal("json").default("json"),
    /** A subreddit without r/, or `u_<name>` for the account's own profile. */
    sr: z.string().regex(/^(r\/)?[A-Za-z0-9_]{2,21}$|^u[_/][A-Za-z0-9_-]{3,20}$/),
    title: z.string().min(1).max(300),
    kind: z.enum(["self", "link"]),
    text: z.string().max(40_000).optional(),
    url: z.string().url().optional(),
    flair_id: z.string().optional(),
    resubmit: flag.optional(),
    sendreplies: flag.default(true),
  })
  .refine((s) => s.kind !== "link" || s.url, "a link post needs url");
const comment = z.object({
  api_type: z.literal("json").default("json"),
  thing_id: z.string().regex(/^t[13]_[a-z0-9]+$/, "t1_ (a comment) or t3_ (a post)"),
  text: z.string().min(1).max(10_000),
});

const about = z.object({
  username: z.string().regex(/^[A-Za-z0-9_-]{3,20}$/, "a Reddit username"),
});
const listing = z.object({
  subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/),
  limit,
  after: z.string().optional(),
});
const srSearch = z.object({
  subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/),
  q: z.string().min(1).max(512),
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).default("new"),
  t: z.enum(["hour", "day", "week", "month", "year", "all"]).default("month"),
  limit,
  after: z.string().optional(),
  restrict_sr: z.literal("on").default("on"),
});
const sr = z.object({ subreddit: z.string().regex(/^[A-Za-z0-9_]{2,21}$/) });
const top = listing.extend({
  t: z.enum(["hour", "day", "week", "month", "year", "all"]).default("week"),
});
const srFind = z.object({ q: z.string().min(1).max(512), limit, after: z.string().optional() });
const search = srSearch.omit({ subreddit: true, restrict_sr: true }).extend({
  type: z.enum(["link", "sr", "user"]).default("link"),
});
const inbox = z.object({
  where: z.enum(["inbox", "unread", "sent"]).default("inbox"),
  limit,
  after: z.string().optional(),
  /** `true` marks what the listing shows as read, as the inbox page does. */
  mark: flag.default(false),
});
const compose = z.object({
  api_type: z.literal("json").default("json"),
  to: z.string().regex(/^(\/?u\/)?[A-Za-z0-9_-]{3,20}$/, "a Reddit username"),
  subject: z.string().min(1).max(100),
  text: z.string().min(1).max(10_000),
});

const read = "reddit/read";

export const reddit: SiteApi = {
  site: "reddit",
  origin: REDDIT_ORIGIN,
  // No client: every route is a browser leg, signed in as the account's own profile.
  auth: { open: true },
  // Messages the lowest: the first thing Reddit shadowbans is an account messaging strangers fast.
  caps: { reads: 300, posts: 3, comments: 20, messages: 5 },
  pace: { gapMs: 20_000, jitterMs: 40_000 },
  routes: [
    route({
      method: "GET",
      path: "/api/v1/me",
      request: z.object({}),
      meter: () => ({ reads: 1 }),
      browser: { flow: read, input: () => ({ path: "/api/me" }) },
      summary: "The signed-in account: name, karma, created, verified email",
    }),
    route({
      method: "GET",
      path: "/user/{username}/submitted",
      request: submitted,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ username, ...q }) => ({ path: `/user/${username}/submitted`, query: query(q) }),
      },
      summary: "A user's posts, newest first by default (a Listing of t3)",
    }),
    route({
      method: "GET",
      path: "/user/{username}/comments",
      request: submitted,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ username, ...q }) => ({ path: `/user/${username}/comments`, query: query(q) }),
      },
      summary: "An account's comments (`limit`, `sort`, `after`)",
    }),
    route({
      method: "GET",
      path: "/user/{username}/about",
      request: about,
      meter: () => ({ reads: 1 }),
      browser: { flow: read, input: ({ username }) => ({ path: `/user/${username}/about` }) },
      summary:
        "An account's public card: created_utc, link/comment/total karma, is_suspended, accept_pms",
    }),
    route({
      method: "GET",
      path: "/r/{subreddit}/new",
      request: listing,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ subreddit, ...q }) => ({ path: `/r/${subreddit}/new`, query: query(q) }),
      },
      summary: "A subreddit's newest posts (`limit`, `after`)",
    }),
    route({
      method: "GET",
      path: "/r/{subreddit}/search",
      request: srSearch,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ subreddit, ...q }) => ({ path: `/r/${subreddit}/search`, query: query(q) }),
      },
      summary: "Posts in one subreddit matching `q` (`sort`, `t`, `limit`, `after`)",
    }),
    route({
      method: "GET",
      path: "/r/{subreddit}/top",
      request: top,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ subreddit, ...q }) => ({ path: `/r/${subreddit}/top`, query: query(q) }),
      },
      summary: "A subreddit's top posts over `t` (default week; `limit`, `after`)",
    }),
    route({
      method: "GET",
      path: "/r/{subreddit}/about",
      request: sr,
      meter: () => ({ reads: 1 }),
      browser: { flow: read, input: ({ subreddit }) => ({ path: `/r/${subreddit}/about` }) },
      summary:
        "A subreddit's card: subscribers, active, description, type, over18, submission_type, submit_text",
    }),
    route({
      method: "GET",
      path: "/subreddits/search",
      request: srFind,
      meter: () => ({ reads: 1 }),
      browser: { flow: read, input: (q) => ({ path: "/subreddits/search", query: query(q) }) },
      summary: "Subreddits matching `q` (t5 cards, as `/r/{subreddit}/about` shows them)",
    }),
    route({
      method: "GET",
      path: "/search",
      request: search,
      meter: () => ({ reads: 1 }),
      browser: { flow: read, input: (q) => ({ path: "/search", query: query(q) }) },
      summary: "Posts (or `type=sr` subreddits, `type=user` accounts) matching `q` site-wide",
    }),
    route({
      method: "GET",
      path: "/message/{where}",
      request: inbox,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ where, ...q }) => ({ path: `/message/${where}`, query: query(q) }),
      },
      summary:
        "The account's messages: `where` = inbox (everything in), unread, sent; `mark=true` marks them read",
    }),
    route({
      method: "GET",
      path: "/api/info",
      request: info,
      meter: () => ({ reads: 1 }),
      browser: { flow: read, input: ({ id }) => ({ path: "/api/info", query: { id } }) },
      summary: "Things by fullname (`t3_abc,t1_def`): score, comment count, permalink",
    }),
    route({
      method: "GET",
      path: "/comments/{article}",
      request: comments,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ article, ...q }) => ({ path: `/comments/${article}`, query: query(q) }),
      },
      summary: "A post and its comments: [Listing of the post, Listing of comments]",
    }),
    route({
      method: "GET",
      path: "/r/{subreddit}/about/rules",
      request: rules,
      meter: () => ({ reads: 1 }),
      browser: {
        flow: read,
        input: ({ subreddit }) => ({ path: `/r/${subreddit}/about/rules` }),
      },
      summary: "A subreddit's rules: read before posting there",
    }),
    route({
      method: "POST",
      path: "/api/submit",
      request: submit,
      irreversible: true,
      meter: () => ({ posts: 1 }),
      browser: {
        flow: "reddit/submit",
        input: (s) => ({ ...s, sr: s.sr.replace(/^r\//, "") }),
      },
      summary:
        "! A text or link post into a subreddit (or u_<name>, the profile); answers {json:{errors,data:{id,name,url}}}",
    }),
    route({
      method: "POST",
      path: "/api/comment",
      request: comment,
      irreversible: true,
      meter: () => ({ comments: 1 }),
      browser: { flow: "reddit/comment" },
      summary: "! A comment on a post (t3_) or a reply to a comment (t1_)",
    }),
    route({
      method: "POST",
      path: "/api/compose",
      request: compose,
      irreversible: true,
      meter: () => ({ messages: 1 }),
      browser: {
        flow: "reddit/message",
        input: (m) => ({ to: m.to.replace(/^\/?u\//, ""), subject: m.subject, text: m.text }),
      },
      summary:
        "! A private message to an account (not chat); answers {json:{errors,data:{delivered}}}; 5 a day",
    }),
  ],
  setup: [],
};

/** The account's own reads: never under the signed-out site. */
const OWN = new Set(["/api/v1/me", "/message/{where}"]);

/**
 * Reddit's public reads, signed out in a profile of their own: finding places, threads and
 * people (designs/2026-10-06-reddit-discovery.md). Read volume on a signed-in account is what
 * Reddit flags; signed out, the only cost is the rate limit. Same flow as `reddit`, never its profile.
 */
export const redditPublic: SiteApi = {
  site: "reddit-public",
  origin: REDDIT_ORIGIN,
  auth: { open: true },
  signedOut: true,
  caps: { reads: 400 },
  pace: { gapMs: 6_000, jitterMs: 3_000 },
  routes: reddit.routes
    .filter((r) => r.method === "GET" && !OWN.has(r.path))
    .map((r) => {
      const leg = r.browser;
      if (!leg) return r;
      const input = leg.input;
      return {
        ...r,
        browser: {
          ...leg,
          input: (q: never, env: (name: string) => string | undefined) => ({
            ...((input ? input(q, env) : q) as object),
            signedOut: true,
          }),
        },
      };
    }),
  setup: [],
};
