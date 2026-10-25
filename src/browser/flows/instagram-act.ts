/**
 * Instagram acts on others' accounts through the signed-in page: follow, like a post, comment on
 * one, read one, search posts by words or a hashtag. The Graph API acts only on our own media (and reads
 * other business accounts through business discovery, `meta GET /instagram/{username}`), so
 * these have no API leg. Each is capped per account (sites/instagram.ts).
 *
 * Mapped 2026-10-09 in explore on the instagram profile. A profile's Follow is a `button` in
 * `main` ("Follow", "Follow Back"; "Following" or "Requested" once done; unfollowing asks again
 * with "Unfollow"). A post page (`/p/<code>/`, `/reel/<code>/`) puts the post's heart at 24px
 * (`svg[aria-label=Like][height="24"]`, `Unlike` once liked) and each comment's at 16px; the
 * comment box is `textarea[aria-label="Add a comment…"]` and its Post button a `div[role=button]`.
 * Its `og:description` reads `184K likes, 288 comments - natgeo on October 7, 2026: "caption"`.
 *
 * Who we follow (mapped 2026-10-22): the Following dialog pages the page's own
 * `/api/v1/friendships/<ds_user_id>/following/` call, `{ users: [{ username, full_name }], next_max_id }`.
 * The flow makes that call from the signed-in page, a page at a time, with a person's pause between.
 */
import type { Response } from "playwright";
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { scrollCollect } from "../scroll-collect.js";
import { firstShown, RENDER_MS, SETTLE_MS, scrollList } from "./kit.js";

const WEB = "https://www.instagram.com";

const SIGNED_OUT = /\/accounts\/login\b/;
const MISSING = /sorry, this page isn.t available|the link you followed may be broken/i;
const BLOCKED = /try again later|we restrict certain activity|action blocked/i;

async function openIg(fp: FlowPage, url: string): Promise<void> {
  await fp.open(url);
  if (SIGNED_OUT.test(fp.url()))
    fp.human("Instagram is signed out on this profile: `autobrowse login instagram`");
}

/** Instagram refused the act ("Try Again Later"): a person looks before the account is flagged. */
async function refused(fp: FlowPage, what: string): Promise<void> {
  const text = await fp.text();
  if (BLOCKED.test(text)) fp.human(`Instagram refused the ${what}: ${text.slice(0, 200)}`);
}

// The first match is the profile's own: suggested accounts below carry their own Follow.
const followButton: Hints = { role: "button", name: "/^follow( back)?$/i" };
const followingButton: Hints = { role: "button", name: "/^(following|requested)$/i" };
const unfollow: Hints = { role: "button", name: "/^unfollow$/i" };

export interface FollowInput {
  username: string;
  undo?: boolean;
}

export const instagramFollow = defineFlow<
  FollowInput,
  { username: string; following: boolean; already?: true } | { found: false; reason: string }
>({
  site: "instagram",
  name: "follow",
  async run(fp, { username, undo }) {
    await openIg(fp, `${WEB}/${encodeURIComponent(username)}/`);
    const state = await firstShown(fp, [followingButton, followButton], MISSING);
    if (state === "missing") return { found: false, reason: `no Instagram account @${username}` };
    if (state === null) return fp.human(`no Follow button on @${username} (${fp.url()})`);
    const following = state === 0;
    if (following === !undo) return { username, following, already: true };
    if (undo) {
      await fp.act({ kind: "click" }, followingButton, { goal: `open @${username}'s Following` });
      await fp.act({ kind: "click" }, unfollow, { goal: `unfollow @${username}` });
    } else await fp.act({ kind: "click" }, followButton, { goal: `follow @${username}` });
    await fp.wait(SETTLE_MS);
    await refused(fp, undo ? "unfollow" : "follow");
    if (!(await fp.has(undo ? followButton : followingButton, RENDER_MS)))
      return fp.human(`Instagram did not take the ${undo ? "unfollow" : "follow"} of @${username}`);
    return { username, following: !undo };
  },
});

export const postUrl = (shortcode: string) => `${WEB}/p/${encodeURIComponent(shortcode)}/`;
const heart: Hints = { css: 'main svg[aria-label="Like"][height="24"]' };
const hearted: Hints = { css: 'main svg[aria-label="Unlike"][height="24"]' };

export interface PostInput {
  /** The code in `/p/<code>/` or `/reel/<code>/`. */
  shortcode: string;
}

export interface LikeInput extends PostInput {
  undo?: boolean;
}

export const instagramLike = defineFlow<
  LikeInput,
  { shortcode: string; liked: boolean; already?: true } | { found: false; reason: string }
>({
  site: "instagram",
  name: "like",
  async run(fp, { shortcode, undo }) {
    await openIg(fp, postUrl(shortcode));
    const state = await firstShown(fp, [hearted, heart], MISSING);
    if (state === "missing") return { found: false, reason: `no Instagram post ${shortcode}` };
    if (state === null) return fp.human(`no Like on post ${shortcode} (${fp.url()})`);
    const liked = state === 0;
    if (liked === !undo) return { shortcode, liked, already: true };
    await fp.act({ kind: "click" }, undo ? hearted : heart, {
      goal: `${undo ? "unlike" : "like"} post ${shortcode}`,
    });
    await fp.wait(SETTLE_MS);
    await refused(fp, undo ? "unlike" : "like");
    if (!(await fp.has(undo ? heart : hearted, RENDER_MS)))
      return fp.human(`Instagram did not take the ${undo ? "unlike" : "like"} on ${shortcode}`);
    return { shortcode, liked: !undo };
  },
});

const commentBox: Hints = { css: 'textarea[aria-label="Add a comment…"]' };
const postComment: Hints = { role: "button", name: "/^post$/i" };

export interface CommentInput extends PostInput {
  text: string;
}

export const instagramComment = defineFlow<
  CommentInput,
  { shortcode: string; commented: true } | { found: false; reason: string }
>({
  site: "instagram",
  name: "comment",
  async run(fp, { shortcode, text }) {
    await openIg(fp, postUrl(shortcode));
    const state = await firstShown(fp, [commentBox], MISSING);
    if (state === "missing") return { found: false, reason: `no Instagram post ${shortcode}` };
    if (state === null)
      return fp.human(`no comment box on post ${shortcode}: comments may be off (${fp.url()})`);
    await fp.act({ kind: "fill", value: text }, commentBox, { goal: "type the comment" });
    await fp.wait(SETTLE_MS);
    await fp.act({ kind: "click" }, postComment, {
      goal: `comment on post ${shortcode}`,
      irreversible: true,
    });
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      await fp.wait(SETTLE_MS);
      await refused(fp, "comment");
      if (/couldn.t post comment|comment couldn.t be posted/i.test(await fp.text()))
        return fp.human(`Instagram did not post the comment on ${shortcode}`);
      // The box empties once Instagram takes the comment.
      if (!(await fp.read(commentBox))) return { shortcode, commented: true };
    }
    return { shortcode, commented: true };
  },
});

export interface IgPost {
  shortcode: string;
  url: string;
  username: string | null;
  caption: string;
  likes: number | null;
  comments: number | null;
  timestamp: string | null;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const unescapeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : (ENTITY[e.toLowerCase()] ?? m),
  );

const meta = (html: string, prop: string) => {
  const tag = new RegExp(`<meta\\b[^>]*property="${prop}"[^>]*>`).exec(html)?.[0];
  const v = tag ? /content="([^"]*)"/.exec(tag)?.[1] : undefined;
  return v === undefined ? null : unescapeHtml(v);
};

/** "184K" → 184000. */
export function countOf(s: string | undefined): number | null {
  const m = /^([\d.,]+)\s*([KkMm]?)$/.exec(s?.trim() ?? "");
  if (!m?.[1]) return null;
  const n = Number(m[1].replaceAll(",", ""));
  return Math.round(
    n * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1),
  );
}

/** "- natgeo on October 7, 2026:" as that day (UTC midnight), when the page has no `<time>`. */
function dayOf(desc: string): string | null {
  const d = / on ([A-Z][a-z]+ \d{1,2}, \d{4}):/.exec(desc)?.[1];
  const t = d ? Date.parse(`${d} UTC`) : Number.NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** A post page's meta tags as a post; null when the page is not one. */
export function igPostOf(html: string, shortcode: string): IgPost | null {
  const desc = meta(html, "og:description");
  if (!desc) return null;
  const head =
    /^(?:([\d.,]+[KkMm]?) likes?, )?(?:([\d.,]+[KkMm]?) comments? )?- ([A-Za-z0-9._]+) on [^:]+:\s*/.exec(
      desc,
    );
  const quoted = desc.slice(head?.[0].length ?? 0).trim();
  const caption = /^"([\s\S]*)"\.?$/.exec(quoted)?.[1] ?? quoted;
  return {
    shortcode,
    url: postUrl(shortcode),
    username: head?.[3] ?? null,
    caption,
    likes: countOf(head?.[1]),
    comments: countOf(head?.[2]),
    timestamp: /<time\b[^>]*datetime="([^"]+)"/.exec(html)?.[1] ?? dayOf(desc),
  };
}

export const instagramPost = defineFlow<PostInput, IgPost | { found: false; reason: string }>({
  site: "instagram",
  name: "post",
  async run(fp, { shortcode }) {
    await openIg(fp, postUrl(shortcode));
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      const post = igPostOf(await fp.html(), shortcode);
      if (post?.username) return post;
      if (MISSING.test(await fp.text()))
        return { found: false, reason: `no Instagram post ${shortcode}` };
      await fp.wait(SETTLE_MS);
    }
    return fp.human(`post ${shortcode} did not render (${fp.url()})`);
  },
});

/** Post codes in links, in page order. */
export function postCodesOf(hrefs: readonly string[]): string[] {
  const codes = hrefs.map((h) => /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel)\/([\w-]+)\/?$/.exec(h)?.[1]);
  return [...new Set(codes.filter((c): c is string => Boolean(c)))];
}

/** The little of the DOM the page script touches; the project compiles without lib dom. */
declare const document: {
  cookie: string;
  querySelectorAll(
    sel: string,
  ): Iterable<{ getAttribute(n: string): string | null; textContent: string | null }>;
};

export interface SearchInput {
  /** Words or a #hashtag. */
  q: string;
  max?: number;
}

/**
 * Instagram's keyword search (a hashtag page lands here too): the posts it shows, top first, as
 * codes to read one by one. The page runs past a megabyte, so links are read in the page.
 */
export const instagramSearch = defineFlow<SearchInput, { q: string; shortcodes: string[] }>({
  site: "instagram",
  name: "search",
  async run(fp, { q, max }) {
    await openIg(fp, `${WEB}/explore/search/keyword/?${new URLSearchParams({ q })}`);
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      const hrefs = await fp.page.evaluate(() =>
        [...document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')].map(
          (a) => a.getAttribute("href") ?? "",
        ),
      );
      const codes = postCodesOf(hrefs);
      if (codes.length) return { q, shortcodes: codes.slice(0, max ?? 12) };
      if (MISSING.test(await fp.text())) return { q, shortcodes: [] };
      await fp.wait(SETTLE_MS);
    }
    return { q, shortcodes: [] };
  },
});

/** The page's own app id: its calls carry it, and the API refuses one without it. */
const IG_APP_ID = "936619743392459";
const FOLLOWING_PAGE = 50;
const FOLLOWING_PAUSE_MS = 2_000;

export interface IgFollowed {
  username: string;
  name: string | null;
}

/** One `users` row of the following call; null when it has no username. */
export function followedOfIg(u: unknown): IgFollowed | null {
  const r = (u ?? {}) as { username?: unknown; full_name?: unknown };
  if (typeof r.username !== "string" || !r.username) return null;
  const name = typeof r.full_name === "string" && r.full_name.trim() ? r.full_name.trim() : null;
  return { username: r.username, name };
}

interface FollowingPage {
  status: number;
  users: unknown[];
  next: string | null;
}

export const instagramFollowing = defineFlow<
  { max?: number },
  { data: IgFollowed[]; meta: { result_count: number } }
>({
  site: "instagram",
  name: "following",
  async run(fp, { max }) {
    const cap = Math.min(Math.max(1, max ?? 1000), 1000);
    await openIg(fp, `${WEB}/`);
    const me = await fp.page.evaluate(() => /ds_user_id=(\d+)/.exec(document.cookie)?.[1] ?? null);
    if (!me)
      return fp.human("Instagram is signed out on this profile: `autobrowse login instagram`");
    const rows = new Map<string, IgFollowed>();
    let after: string | null = null;
    do {
      const got: FollowingPage = await fp.page.evaluate(
        async ({ me, after, count, app }) => {
          const q = `count=${count}${after ? `&max_id=${encodeURIComponent(after)}` : ""}`;
          const r = await fetch(`/api/v1/friendships/${me}/following/?${q}`, {
            headers: { "X-IG-App-ID": app },
          });
          const j = r.ok ? ((await r.json()) as { users?: unknown[]; next_max_id?: unknown }) : {};
          const next = j.next_max_id;
          return {
            status: r.status,
            users: j.users ?? [],
            next: typeof next === "string" || typeof next === "number" ? String(next) : null,
          };
        },
        { me, after, count: FOLLOWING_PAGE, app: IG_APP_ID },
      );
      if (got.status !== 200)
        return fp.human(
          `Instagram answered ${got.status} to the following list (page ${rows.size})`,
        );
      for (const u of got.users) {
        const f = followedOfIg(u);
        if (f && rows.size < cap) rows.set(f.username.toLowerCase(), f);
      }
      after = got.next;
      if (after && rows.size < cap) await fp.wait(FOLLOWING_PAUSE_MS);
    } while (after && rows.size < cap);
    const data = [...rows.values()];
    return { data, meta: { result_count: data.length } };
  },
});

/** The home feed's timeline data: in the page's preloaded scripts, then in its GraphQL answers. */
const FEED_CALL = /\/graphql\b|\/api\/v1\/feed\//;
const FEED_DATA = /feed__timeline|"feed_items"/;
/** The home's "Turn on Notifications" prompt: it holds the page still under it. */
const NOT_NOW: Hints = { role: "button", name: "/^not now$/i" };
/** The last post into view: the feed asks for its next page when the end comes near. */
const FEED_END = `(() => {
  const last = [...document.querySelectorAll("article")].pop();
  if (!last) return false;
  last.scrollIntoView({ block: "end" });
  window.scrollBy(0, innerHeight);
  return true;
})()`;

/** JSON text as the page sends it: one object, or one per line (a streamed answer). */
function jsonsOf(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    return text.split("\n").flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  }
}

interface Media {
  code?: unknown;
  taken_at?: unknown;
  like_count?: unknown;
  comment_count?: unknown;
  caption?: { text?: unknown } | null;
  user?: { username?: unknown; friendship_status?: { following?: unknown } } | null;
}

const countOrNull = (n: unknown) => (typeof n === "number" ? n : null);

/**
 * Every post in a timeline answer, found by shape (a `code`, a `taken_at` and a `user`), so the
 * GraphQL and v1 shapes both read. Ads and posts by accounts ours does not follow are left.
 */
export function feedPostsOf(body: unknown, left?: Set<string>): IgPost[] {
  const out: IgPost[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    // An ad: the node holds an `ad` beside its `media`, or the media carries `ad_id` (v1).
    if (o.ad_id || o.ad_action || o.is_ad || (o.ad && typeof o.ad === "object")) {
      left?.add("ad");
      return;
    }
    const m = o as Media;
    const username = m.user?.username;
    if (
      typeof m.code === "string" &&
      typeof m.taken_at === "number" &&
      typeof username === "string"
    ) {
      if (m.user?.friendship_status?.following === false) {
        left?.add(m.code);
        return;
      }
      out.push({
        shortcode: m.code,
        url: postUrl(m.code),
        username,
        caption: typeof m.caption?.text === "string" ? m.caption.text : "",
        likes: countOrNull(m.like_count),
        comments: countOrNull(m.comment_count),
        timestamp: new Date(m.taken_at * 1000).toISOString(),
      });
      return;
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(body);
  return out;
}

/**
 * The signed-in account's home feed: posts by the accounts it follows, newest first as Instagram
 * orders them, with caption and counts, in one load scrolled deep. Read off the page's own
 * timeline data; the flow makes no call of its own.
 */
export const instagramFeed = defineFlow<
  { max?: number },
  {
    data: IgPost[];
    meta: { result_count: number; left: number; pages: number; calls?: string[] };
  }
>({
  site: "instagram",
  name: "feed",
  async run(fp, { max }) {
    const cap = Math.min(Math.max(1, max ?? 20), 50);
    const bodies: unknown[] = [];
    const pending: Array<Promise<void>> = [];
    /** The page's API calls by name, to say what came when no next page did. */
    const calls = new Set<string>();
    const onResponse = (r: Response) => {
      if (!/\/(graphql|api)\//.test(r.url())) return;
      const name = /fb_api_req_friendly_name=(\w+)/.exec(r.request().postData() ?? "")?.[1];
      calls.add(`${name ?? new URL(r.url()).pathname} ${r.status()}`);
      if (!FEED_CALL.test(r.url())) return;
      pending.push(
        r.text().then(
          (t) => {
            if (FEED_DATA.test(t)) bodies.push(...jsonsOf(t));
          },
          () => undefined,
        ),
      );
    };
    fp.page.on("response", onResponse);
    try {
      await openIg(fp, `${WEB}/`);
      const preloaded = async () =>
        (
          await fp.page.evaluate(() =>
            [...document.querySelectorAll('script[type="application/json"]')].map(
              (s) => s.textContent ?? "",
            ),
          )
        ).filter((t) => FEED_DATA.test(t));
      for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
        await Promise.all(pending);
        if (bodies.length || (await preloaded()).length) break;
        await fp.wait(SETTLE_MS);
      }
      if (await fp.has(NOT_NOW, 1_000))
        await fp.act({ kind: "click" }, NOT_NOW, { goal: "close the notifications prompt" });
      const { rows } = await scrollCollect(fp, {
        read: async () => {
          await Promise.all(pending);
          const scripts = (await preloaded()).flatMap(jsonsOf);
          return [...scripts, ...bodies].flatMap((b) => feedPostsOf(b));
        },
        // The next page is a network call, not rows already in the DOM: give it time.
        idle: 5,
        settleMs: 2_000,
        scroll: () => scrollList(fp, FEED_END),
        key: (p) => p.shortcode,
        max: cap,
      });
      if (!rows.length && !bodies.length && !(await preloaded()).length)
        return fp.human(`the Instagram home feed showed no timeline data (${fp.url()})`);
      // What was left (posts by accounts not followed, ads) and the pages read: a thin feed
      // says which it was.
      const left = new Set<string>();
      for (const b of [...(await preloaded()).flatMap(jsonsOf), ...bodies]) feedPostsOf(b, left);
      return {
        data: rows,
        meta: {
          result_count: rows.length,
          left: left.size,
          pages: bodies.length,
          ...(bodies.length ? {} : { calls: [...calls].slice(0, 30) }),
        },
      };
    } finally {
      fp.page.off("response", onResponse);
    }
  },
});
