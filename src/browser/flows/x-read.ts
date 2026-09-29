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
}

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
  return { data, meta: metaOf(data) };
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

export const xPosts = defineFlow<PostsInput, unknown>({
  site: "x",
  name: "posts",
  run: (fp, i) => feed(fp, /^\d+$/.test(i.id) ? `${WEB}/i/user/${i.id}` : `${WEB}/${i.id}`, i),
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
