/**
 * X reads through the signed-in page, in API v2's shapes: a profile, a
 * user's posts, a search, one post. X's API bills every read; the page
 * shows the same things for free to a signed-in account, so the x routes
 * send reads here (`prefer: "browser"`) and pace them per account.
 *
 * Mapped 2026-09-29 in explore as x@wren. A profile page carries a
 * `script[type="application/ld+json"]` ProfilePage: the id, handle, bio,
 * location, avatar, counts and join date, so the profile is read from
 * data, not text. A post is an `article[data-testid=tweet]`: `User-Name`
 * reads "Name\n@handle\n·\n4h", `tweetText` the text, `time[datetime]`
 * sits in the `/<handle>/status/<id>` link, `socialContext` says "Pinned"
 * or "<name> reposted", and the `[role=group]` aria-label carries the
 * counts ("82 replies, 64 reposts, 555 likes, 312 bookmarks, 122909
 * views"). Timelines are virtualized, so rows are collected while
 * scrolling (`scrollCollect`).
 */
import type { Response } from "playwright";
import { defineFlow, type FlowPage } from "../flow.js";
import { scrollCollect } from "../scroll-collect.js";

/** The little of the DOM these page scripts touch; the project compiles without lib dom. */
interface El {
  innerText: string;
  textContent: string | null;
  src: string;
  getAttribute(name: string): string | null;
  closest(sel: string): El | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;

const WEB = "https://x.com";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_000;

/** A post as the page shows it, before parsing. */
export interface RawTweet {
  user: string;
  text: string;
  time: string | null;
  href: string | null;
  social: string;
  metrics: string;
  photos: string[];
}

export interface PublicMetrics {
  reply_count: number;
  retweet_count: number;
  like_count: number;
  bookmark_count: number;
  impression_count: number;
}

export interface Tweet {
  id: string;
  text: string;
  author_username: string;
  author_name?: string;
  created_at?: string;
  public_metrics: PublicMetrics;
  /** Pinned to the top of the profile: out of date order. */
  pinned?: true;
  /** Shown on this timeline because the named account reposted it. */
  reposted_by?: string;
  photos?: string[];
}

export interface User {
  id: string;
  username: string;
  name: string;
  description?: string;
  location?: string;
  url?: string;
  created_at?: string;
  profile_image_url?: string;
  public_metrics: { followers_count: number; following_count: number; tweet_count: number };
}

/** X API v2 answers a missing user or post with 200 and `errors`; so do these. */
export interface NotFound {
  errors: [{ title: "Not Found Error"; detail: string }];
}
const notFound = (detail: string): NotFound => ({ errors: [{ title: "Not Found Error", detail }] });

const STATUS = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
const METRIC = /([\d,]+)\s+(repl(?:y|ies)|reposts?|likes?|bookmarks?|views?)/gi;

export function metricsOf(label: string): PublicMetrics {
  const m: PublicMetrics = {
    reply_count: 0,
    retweet_count: 0,
    like_count: 0,
    bookmark_count: 0,
    impression_count: 0,
  };
  for (const [, n, what] of label.matchAll(METRIC)) {
    const v = Number((n ?? "0").replaceAll(",", ""));
    const w = (what ?? "").toLowerCase();
    if (w.startsWith("repl")) m.reply_count = v;
    else if (w.startsWith("repost")) m.retweet_count = v;
    else if (w.startsWith("like")) m.like_count = v;
    else if (w.startsWith("bookmark")) m.bookmark_count = v;
    else if (w.startsWith("view")) m.impression_count = v;
  }
  return m;
}

/** One article as a post; null for an ad or a row without a status link. */
export function tweetOf(raw: RawTweet): Tweet | null {
  const link = raw.href ? STATUS.exec(raw.href) : null;
  if (!link?.[1] || !link[2]) return null;
  const t: Tweet = {
    id: link[2],
    text: raw.text,
    author_username: link[1],
    public_metrics: metricsOf(raw.metrics),
  };
  const name = raw.user.split("\n")[0]?.trim();
  if (name) t.author_name = name;
  if (raw.time) t.created_at = raw.time;
  const social = raw.social.trim();
  if (/^pinned$/i.test(social)) t.pinned = true;
  const repost = /^(.+?) reposted$/i.exec(social);
  if (repost?.[1]) t.reposted_by = repost[1];
  if (raw.photos.length) t.photos = raw.photos;
  return t;
}

/** Numeric id order: a newer post has a bigger id. */
export const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export function metaOf(posts: Tweet[]): {
  result_count: number;
  newest_id?: string;
  oldest_id?: string;
} {
  const ids = posts
    .filter((p) => !p.pinned)
    .map((p) => p.id)
    .sort((a, b) => (newer(a, b) ? -1 : 1));
  const [newest, oldest] = [ids[0], ids.at(-1)];
  return newest && oldest
    ? { result_count: posts.length, newest_id: newest, oldest_id: oldest }
    : { result_count: posts.length };
}

interface Ld {
  dateCreated?: string;
  relatedLink?: string[];
  mainEntity?: {
    identifier?: string;
    additionalName?: string;
    name?: string;
    description?: string;
    homeLocation?: { name?: string };
    image?: string | { contentUrl?: string };
    url?: string;
    interactionStatistic?: Array<{ name?: string; userInteractionCount?: number }>;
  };
}

/** The profile page's JSON-LD as a v2 user; null when it is not a profile. */
export function userOf(ld: unknown): User | null {
  const p = (ld as Ld | null)?.mainEntity;
  if (!p?.identifier || !p.additionalName) return null;
  const stat = (n: string) =>
    p.interactionStatistic?.find((s) => s.name === n)?.userInteractionCount ?? 0;
  const u: User = {
    id: String(p.identifier),
    username: p.additionalName,
    name: p.name ?? p.additionalName,
    public_metrics: {
      followers_count: stat("Follows"),
      following_count: stat("Friends"),
      tweet_count: stat("Tweets"),
    },
  };
  if (p.description) u.description = p.description;
  if (p.homeLocation?.name) u.location = p.homeLocation.name;
  const site = (ld as Ld).relatedLink?.find((l) => !/^https?:\/\/(t\.co|x\.com)\//.test(l));
  if (site) u.url = site;
  if ((ld as Ld).dateCreated) u.created_at = (ld as Ld).dateCreated as string;
  const image = typeof p.image === "string" ? p.image : p.image?.contentUrl;
  if (image) u.profile_image_url = image;
  return u;
}

const tweetsOnPage = (fp: FlowPage): Promise<RawTweet[]> =>
  fp.page.evaluate(() =>
    [...document.querySelectorAll("article[data-testid=tweet]")].map((a) => {
      const time = a.querySelector("time[datetime]");
      return {
        user: a.querySelector("[data-testid=User-Name]")?.innerText ?? "",
        text: a.querySelector("[data-testid=tweetText]")?.innerText ?? "",
        time: time?.getAttribute("datetime") ?? null,
        href: time?.closest("a")?.getAttribute("href") ?? null,
        social: a.querySelector("[data-testid=socialContext]")?.innerText ?? "",
        metrics: a.querySelector("[role=group]")?.getAttribute("aria-label") ?? "",
        photos: [...a.querySelectorAll("[data-testid=tweetPhoto] img")].map((i) => i.src),
      };
    }),
  );

const SIGNED_OUT = /\/(i\/flow\/login|login)\b/;
const MISSING =
  /this account doesn.t exist|this post is from an account that no longer exists|hmm\.\.\.this page doesn.t exist/i;
const EMPTY = /hasn.t posted|no results for/i;
const SUSPENDED = /account suspended/i;

/** Waits for posts to render; [] when the page says there are none. */
async function landed(fp: FlowPage, url: string): Promise<"posts" | "empty" | "missing"> {
  await fp.open(url);
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    if (SIGNED_OUT.test(fp.url()))
      return fp.human("X is signed out on this profile: `autobrowse login x@<account>`");
    if ((await tweetsOnPage(fp)).length) return "posts";
    const text = await fp.text();
    if (MISSING.test(text) || SUSPENDED.test(text)) return "missing";
    if (EMPTY.test(text)) return "empty";
    await fp.wait(SETTLE_MS);
  }
  return "empty";
}

interface Feed {
  max_results?: number;
  /** Stop at this post: only newer ones come back (the cursor a caller keeps). */
  since_id?: string;
  /** "replies", "retweets" (comma-separated), as the API takes it. */
  exclude?: string;
  /** `author_id` adds `includes.users`, each author once, as the API answers it. */
  expansions?: string;
}

/** The authors once each, in the API's `includes.users` (the page has no numeric ids). */
export const authorsOf = (data: Tweet[]) => [
  ...new Map(
    data.map((t) => [
      t.author_username.toLowerCase(),
      { username: t.author_username, name: t.author_name ?? t.author_username },
    ]),
  ).values(),
];

async function feed(fp: FlowPage, url: string, i: Feed) {
  const state = await landed(fp, url);
  if (state === "missing") return notFound(`nothing at ${url}`);
  if (state === "empty") return { data: [], meta: { result_count: 0 } };
  const noReposts = /retweets/.test(i.exclude ?? "");
  const { rows } = await scrollCollect(fp, {
    read: async () =>
      (await tweetsOnPage(fp))
        .map(tweetOf)
        .filter((t): t is Tweet => t !== null && !(noReposts && t.reposted_by)),
    key: (t) => t.id,
    max: i.max_results ?? 10,
    // A pinned post and a repost (the original's id) are out of id order, so neither ends the feed.
    skip: (t) => t.pinned === true || t.reposted_by !== undefined,
    ...(i.since_id ? { stop: (t: Tweet) => !newer(t.id, i.since_id as string) } : {}),
  });
  const data = i.since_id ? rows.filter((t) => newer(t.id, i.since_id as string)) : rows;
  return {
    data,
    ...(/\bauthor_id\b/.test(i.expansions ?? "") ? { includes: { users: authorsOf(data) } } : {}),
    meta: metaOf(data),
  };
}

export const xProfile = defineFlow<{ username: string }, { data: User } | NotFound>({
  site: "x",
  name: "profile",
  async run(fp, { username }) {
    await fp.open(`${WEB}/${username}`);
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      if (SIGNED_OUT.test(fp.url()))
        return fp.human("X is signed out on this profile: `autobrowse login x@<account>`");
      const ld = await fp.page.evaluate(() =>
        [...document.querySelectorAll('script[type="application/ld+json"]')].map(
          (s) => s.textContent ?? "",
        ),
      );
      for (const raw of ld) {
        const user = userOf(JSON.parse(raw));
        if (user) return { data: user };
      }
      const text = await fp.text();
      if (MISSING.test(text) || SUSPENDED.test(text)) return notFound(`no X user @${username}`);
      await fp.wait(SETTLE_MS);
    }
    return notFound(`no profile data for @${username} (${fp.url()})`);
  },
});

export interface PostsInput extends Feed {
  /** A numeric user id or a handle. */
  id: string;
}

/** A post of the account's own, from the page's data: the API's reply fields with it. */
export interface TimelineTweet extends Tweet {
  url: string;
  conversation_id?: string;
  in_reply_to_status_id?: string;
  in_reply_to_user_id?: string;
  /** The replied-to post's author. */
  in_reply_to?: { username: string; name: string };
  referenced_tweets?: Array<{ type: "replied_to"; id: string }>;
}

/** The little of X's GraphQL timeline item this reads. */
interface GqlUser {
  rest_id?: string;
  core?: { screen_name?: string; name?: string };
  legacy?: { screen_name?: string; name?: string };
}
interface GqlTweet {
  __typename?: string;
  tweet?: GqlTweet;
  rest_id?: string;
  core?: { user_results?: { result?: GqlUser } };
  note_tweet?: { note_tweet_results?: { result?: { text?: string } } };
  views?: { count?: string };
  legacy?: {
    id_str?: string;
    full_text?: string;
    created_at?: string;
    conversation_id_str?: string;
    in_reply_to_status_id_str?: string;
    in_reply_to_user_id_str?: string;
    in_reply_to_screen_name?: string;
    retweeted_status_result?: unknown;
    reply_count?: number;
    retweet_count?: number;
    favorite_count?: number;
    bookmark_count?: number;
  };
}

const unentity = (t: string) =>
  t.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const userOfGql = (u: GqlUser | undefined) => {
  const username = u?.core?.screen_name ?? u?.legacy?.screen_name;
  return username
    ? { id: u?.rest_id, username, name: u?.core?.name ?? u?.legacy?.name ?? username }
    : null;
};

/**
 * Every post in one timeline answer (the replied-to posts above each reply
 * too), with their reply fields. A quoted post is not a row. A pinned entry
 * comes back `pinned`.
 */
export function timelineTweets(body: unknown): TimelineTweet[] {
  const tweets = new Map<string, TimelineTweet>();
  const users = new Map<string, { username: string; name: string }>();
  const replies: Array<[TimelineTweet, string | undefined]> = [];
  const visit = (node: unknown, pinned: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, pinned);
      return;
    }
    const o = node as Record<string, unknown>;
    const pin = pinned || o.type === "TimelinePinEntry";
    const found = (o.tweet_results as { result?: GqlTweet } | undefined)?.result;
    const t = found?.__typename === "TweetWithVisibilityResults" ? found.tweet : found;
    const l = t?.legacy;
    if (t && l?.id_str) {
      const author = userOfGql(t.core?.user_results?.result);
      if (author?.id) users.set(author.id, author);
      if (author && !tweets.has(l.id_str)) {
        const row: TimelineTweet = {
          id: l.id_str,
          text: unentity(t.note_tweet?.note_tweet_results?.result?.text ?? l.full_text ?? ""),
          author_username: author.username,
          author_name: author.name,
          url: `${WEB}/${author.username}/status/${l.id_str}`,
          public_metrics: {
            reply_count: l.reply_count ?? 0,
            retweet_count: l.retweet_count ?? 0,
            like_count: l.favorite_count ?? 0,
            bookmark_count: l.bookmark_count ?? 0,
            impression_count: Number(t.views?.count ?? 0) || 0,
          },
        };
        const at = l.created_at ? new Date(l.created_at) : null;
        if (at && !Number.isNaN(at.getTime())) row.created_at = at.toISOString();
        if (l.conversation_id_str) row.conversation_id = l.conversation_id_str;
        if (pin) row.pinned = true;
        if (l.retweeted_status_result) row.reposted_by = author.name;
        const parent = l.in_reply_to_status_id_str;
        if (parent) {
          row.in_reply_to_status_id = parent;
          row.referenced_tweets = [{ type: "replied_to", id: parent }];
          if (l.in_reply_to_user_id_str) row.in_reply_to_user_id = l.in_reply_to_user_id_str;
          replies.push([row, l.in_reply_to_screen_name]);
        }
        tweets.set(l.id_str, row);
      }
    }
    for (const [k, v] of Object.entries(o)) {
      // A quoted or reposted post sits inside its row; it is no row of its own.
      if (k === "quoted_status_result" || k === "retweeted_status_result" || k === "legacy")
        continue;
      visit(v, pin);
    }
  };
  visit(body, false);
  for (const [row, handle] of replies) {
    const parent = tweets.get(row.in_reply_to_status_id as string);
    const user = row.in_reply_to_user_id ? users.get(row.in_reply_to_user_id) : undefined;
    const username = parent?.author_username ?? user?.username ?? handle;
    if (username)
      row.in_reply_to = { username, name: parent?.author_name ?? user?.name ?? username };
  }
  return [...tweets.values()];
}

/** The replies tab's timeline call. */
const REPLIES_CALL = "/UserTweetsAndReplies";
const REPLIES_TAB = { role: "tab", name: "/^replies$/i" };

/**
 * The account's own posts and replies, newest first, off its Replies tab,
 * read from the page's own timeline data (each reply's parent and its author
 * included). Pinned posts and, with `exclude=retweets`, reposts are left out
 * of nothing but come back marked.
 */
async function withReplies(fp: FlowPage, id: string, i: Feed) {
  const bodies: unknown[] = [];
  const pending: Array<Promise<void>> = [];
  /** The page's GraphQL calls by name, to say what came instead when no timeline answer did. */
  const calls = new Set<string>();
  const onResponse = (r: Response) => {
    const op = /\/graphql\/[^/]+\/(\w+)/.exec(r.url())?.[1];
    if (op) calls.add(`${op} ${r.status()}`);
    if (!r.url().includes(REPLIES_CALL)) return;
    pending.push(
      r.json().then(
        (b: unknown) => {
          bodies.push(b);
        },
        () => undefined,
      ),
    );
  };
  // Timeline-like calls first: the error text is cut short on the way back.
  const stuck = (why: string) => {
    const all = [...calls];
    const near = all.filter((c) => /tweet|timeline|repl|conversation/i.test(c));
    return new Error(
      `x/posts: the Replies tab ${why} (calls: ${[...near, `${all.length - near.length} others`].join(", ")}; ${fp.url()})`,
    );
  };
  fp.page.on("response", onResponse);
  try {
    const profile = /^\d+$/.test(id) ? `${WEB}/i/user/${id}` : `${WEB}/${id}`;
    if ((await landed(fp, profile)) === "missing") return notFound(`nothing at ${profile}`);
    // Opened straight, /with_replies makes no timeline call (2026-10-22); its tab does.
    await fp.act({ kind: "click" }, REPLIES_TAB, { goal: "open the Replies tab" });
    for (let n = 0; n < RENDER_MS / SETTLE_MS && !bodies.length; n++) {
      await fp.wait(SETTLE_MS);
      await Promise.all(pending);
    }
    const handle = /x\.com\/([A-Za-z0-9_]{1,15})\/with_replies/.exec(fp.url())?.[1];
    if (!handle) throw stuck("did not open");
    if (!bodies.length) throw stuck("made no timeline call");
    const me = handle.toLowerCase();
    const noReposts = /retweets/.test(i.exclude ?? "");
    const own = async () => {
      await Promise.all(pending);
      return bodies
        .flatMap(timelineTweets)
        .filter((t) => t.author_username.toLowerCase() === me && !(noReposts && t.reposted_by))
        .sort((a, b) => (newer(a.id, b.id) ? -1 : 1));
    };
    const { rows, ended } = await scrollCollect(fp, {
      read: own,
      key: (t) => t.id,
      max: i.max_results ?? 10,
      skip: (t) => t.pinned === true,
      ...(i.since_id ? { stop: (t: TimelineTweet) => !newer(t.id, i.since_id as string) } : {}),
    });
    // Posts on the page but none read: the page's data changed shape, not an empty account.
    if (!rows.length && ended !== "cursor" && (await tweetsOnPage(fp)).length)
      throw stuck(`shows posts but ${bodies.length} timeline answers held none of theirs`);
    const data = i.since_id ? rows.filter((t) => newer(t.id, i.since_id as string)) : rows;
    return {
      data,
      ...(/\bauthor_id\b/.test(i.expansions ?? "") ? { includes: { users: authorsOf(data) } } : {}),
      meta: metaOf(data),
    };
  } finally {
    fp.page.off("response", onResponse);
  }
}

/**
 * As the API: replies come back unless `exclude` names them, each with
 * `in_reply_to_status_id` and its parent's author (the Replies tab); with
 * replies excluded, the profile's Posts tab.
 */
export const xPosts = defineFlow<PostsInput, unknown>({
  site: "x",
  name: "posts",
  run: (fp, i) =>
    /replies/.test(i.exclude ?? "")
      ? feed(fp, /^\d+$/.test(i.id) ? `${WEB}/i/user/${i.id}` : `${WEB}/${i.id}`, i)
      : withReplies(fp, i.id, i),
});

export interface SearchInput extends Feed {
  query: string;
}

/** Latest first (`f=live`), the order the API's recent search answers in. */
export const searchUrl = (query: string): string =>
  `${WEB}/search?${new URLSearchParams({ q: query, f: "live", src: "typed_query" })}`;

export const xSearch = defineFlow<SearchInput, unknown>({
  site: "x",
  name: "search",
  run: (fp, i) => feed(fp, searchUrl(i.query), i),
});

export const xPost = defineFlow<{ id: string }, { data: Tweet } | NotFound>({
  site: "x",
  name: "post",
  async run(fp, { id }) {
    const state = await landed(fp, `${WEB}/i/status/${id}`);
    if (state !== "posts") return notFound(`no X post ${id}`);
    const post = (await tweetsOnPage(fp)).map(tweetOf).find((t) => t?.id === id);
    return post ? { data: post } : notFound(`post ${id} did not render (${fp.url()})`);
  },
});

/** One account the signed-in account follows, as its Following page shows it. */
export interface Followed {
  username: string;
  name: string;
  /** The page's "Follows you". */
  follows_you: boolean;
}

/** A Following page cell: "Name\n@handle\nFollows you\nFollowing\nbio", and its profile link. */
export function followedOf(cell: { text: string; hrefs: string[] }): Followed | null {
  const username = cell.hrefs
    .map((h) => /^\/([A-Za-z0-9_]{1,15})$/.exec(h)?.[1])
    .find((h): h is string => !!h);
  if (!username) return null;
  const lines = cell.text.split("\n").map((l) => l.trim());
  const top = lines[0] ?? "";
  const name = top && !top.startsWith("@") ? top : username;
  return { username, name, follows_you: lines.includes("Follows you") };
}

/** Only the page's own list: the sidebar's "Who to follow" cells are left out. */
const cellsOnPage = (fp: FlowPage) =>
  fp.page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=primaryColumn] [data-testid=UserCell]")].map(
      (c) => ({
        text: c.innerText,
        hrefs: [...c.querySelectorAll("a[href^='/']")].map((a) => a.getAttribute("href") ?? ""),
      }),
    ),
  );

const NOT_FOLLOWING = /isn.t following anyone|aren.t following anyone|be in the know/i;

/**
 * Who the signed-in account follows, newest first, in v2's `{ data, meta }`. The page has no
 * numeric ids, so each row is the username and name. The rail's profile link names us.
 */
export const xFollowing = defineFlow<{ max_results?: number }, unknown>({
  site: "x",
  name: "following",
  async run(fp, i) {
    await fp.open(`${WEB}/home`);
    let me: string | null = null;
    for (let n = 0; n < RENDER_MS / SETTLE_MS && !me; n++) {
      if (SIGNED_OUT.test(fp.url()))
        return fp.human("X is signed out on this profile: `autobrowse login x@<account>`");
      // The page's markup is past html()'s cap on /home, so the rail link is read where it is.
      const href = await fp.page.evaluate(
        () =>
          document.querySelector("a[data-testid=AppTabBar_Profile_Link]")?.getAttribute("href") ??
          null,
      );
      me = (href && /^\/([A-Za-z0-9_]{1,15})$/.exec(href)?.[1]) || null;
      if (!me) await fp.wait(SETTLE_MS);
    }
    if (!me) return fp.human("could not tell which X account this profile is signed in as");
    await fp.open(`${WEB}/${me}/following`);
    for (let n = 0; n < RENDER_MS / SETTLE_MS; n++) {
      if ((await cellsOnPage(fp)).length) break;
      if (NOT_FOLLOWING.test(await fp.text())) return { data: [], meta: { result_count: 0 } };
      await fp.wait(SETTLE_MS);
    }
    const { rows } = await scrollCollect(fp, {
      read: async () =>
        (await cellsOnPage(fp)).map(followedOf).filter((f): f is Followed => f !== null),
      key: (f) => f.username.toLowerCase(),
      max: i.max_results ?? 1000,
    });
    if (!rows.length) return fp.human(`no accounts read on ${fp.url()}`);
    return { data: rows, meta: { result_count: rows.length } };
  },
});
