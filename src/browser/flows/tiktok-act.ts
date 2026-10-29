/**
 * Search, comment, like and follow on TikTok as the signed-in account: no public API does any
 * of them on another's video. The search page fetches `/api/search/item/full/` for itself; the
 * flow keeps that JSON (desc, author, bio, counts, time) instead of reading the grid's markup.
 *
 * A video page opens as a feed: the first `article` is the video asked for. Its controls carry
 * `data-e2e` names: `like-icon` (`aria-pressed`), `comment-text` (a contenteditable box in the
 * side panel's Comments tab) and `comment-post`. A comment is taken when the page's own
 * `/api/comment/publish/` call answers `status_code` 0. Follow runs on the profile page, whose
 * `follow-button` reads Follow until it is pressed.
 *
 * Signed out (a guest page) and the slider captcha are walls `open` checks (`wallOf`).
 *
 * Mapped 2026-10-26 in explore on the tiktok profile (reads only; no act was sent).
 */
import type { Response } from "playwright";
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { RENDER_MS, SETTLE_MS } from "./kit.js";
import { openVideo } from "./tiktok-video.js";

const WEB = "https://www.tiktok.com";
const SEARCH = "/api/search/item/full/";
const PUBLISH = "/api/comment/publish/";
const SCROLLS = 6;
export const MAX_SEARCH = 60;
const GONE = /video currently unavailable|couldn.t find this video|this video is private/i;
const NO_ACCOUNT = /couldn.t find this account/i;

export interface TikTokVideo {
  id: string;
  url: string;
  username: string;
  name: string | null;
  bio: string | null;
  text: string;
  /** ISO time; "" when TikTok sent none. */
  at: string;
  likes: number | null;
  comments: number | null;
}

interface RawItem {
  id?: string;
  desc?: string;
  createTime?: number | string;
  author?: { uniqueId?: string; nickname?: string; signature?: string };
  stats?: { diggCount?: number; commentCount?: number };
}

/** Videos from one search call's JSON (`item_list`); a row with no id or author is left. */
export function searchRows(body: unknown): TikTokVideo[] {
  const list = (body as { item_list?: unknown } | null)?.item_list;
  if (!Array.isArray(list)) return [];
  return (list as RawItem[]).flatMap((i) => {
    const username = i.author?.uniqueId;
    if (!i.id || !username) return [];
    const secs = Number(i.createTime);
    return [
      {
        id: String(i.id),
        url: `${WEB}/@${username}/video/${i.id}`,
        username,
        name: i.author?.nickname || null,
        bio: i.author?.signature || null,
        text: i.desc ?? "",
        at: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : "",
        likes: typeof i.stats?.diggCount === "number" ? i.stats.diggCount : null,
        comments: typeof i.stats?.commentCount === "number" ? i.stats.commentCount : null,
      },
    ];
  });
}

export const tiktokSearch = defineFlow<
  { q: string; max?: number },
  { q: string; data: TikTokVideo[] }
>({
  site: "tiktok",
  name: "search",
  async run(fp, { q, max }) {
    const cap = Math.min(Math.max(1, max ?? 30), MAX_SEARCH);
    const bodies: unknown[] = [];
    const pending: Array<Promise<void>> = [];
    const onResponse = (r: Response) => {
      if (!r.url().includes(SEARCH)) return;
      pending.push(
        r.json().then(
          (b: unknown) => {
            bodies.push(b);
          },
          () => undefined,
        ),
      );
    };
    const rows = () => {
      const seen = new Map<string, TikTokVideo>();
      for (const v of bodies.flatMap(searchRows)) if (!seen.has(v.id)) seen.set(v.id, v);
      return [...seen.values()];
    };
    fp.page.on("response", onResponse);
    try {
      await fp.open(`${WEB}/search/video?q=${encodeURIComponent(q)}`);
      for (let i = 0; i < RENDER_MS / SETTLE_MS && !bodies.length; i++) {
        await fp.wait(SETTLE_MS);
        await Promise.all(pending);
      }
      if (!bodies.length) return fp.human(`TikTok's search made no result call (${fp.url()})`);
      let still = 0;
      for (let i = 0; i < SCROLLS && rows().length < cap && still < 2; i++) {
        const before = rows().length;
        await fp.scroll(2_000);
        await fp.wait(SETTLE_MS * 2);
        await Promise.all(pending);
        still = rows().length > before ? 0 : still + 1;
      }
      await Promise.all(pending);
    } finally {
      fp.page.off("response", onResponse);
    }
    return { q, data: rows().slice(0, cap) };
  },
});

/** The asked video's own controls: the browse view's (opened from the grid), else the feed's first article. */
const likeIn = (pressed: boolean): Hints => ({
  css: `button[aria-pressed="${pressed}"]:has([data-e2e="browse-like-icon"]), article:first-of-type [data-e2e="like-icon"][aria-pressed="${pressed}"]`,
});
const like = likeIn(false);
const liked = likeIn(true);

async function videoShown(fp: FlowPage, what: Hints[]): Promise<number | "missing" | null> {
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    for (const [n, h] of what.entries()) if (await fp.has(h)) return n;
    if (GONE.test(await fp.text())) return "missing";
    await fp.wait(SETTLE_MS);
  }
  return null;
}

export interface VideoInput {
  videoId: string;
  /** The video's handle; TikTok sends a wrong one on to the right page. */
  username?: string;
}

export const tiktokLike = defineFlow<
  VideoInput,
  | { videoId: string; liked: true; already?: true }
  | { found: false; status: number; reason: string }
>({
  site: "tiktok",
  name: "like",
  async run(fp, { videoId, username }) {
    const opened = await openVideo(fp, videoId, username);
    if (!opened.opened) return { found: false, status: 404, reason: opened.reason };
    const state = await videoShown(fp, [liked, like]);
    if (state === "missing")
      return { found: false, status: 404, reason: `no TikTok video ${videoId}` };
    if (state === null) return fp.human(`no Like on video ${videoId} (${fp.url()})`);
    if (state === 0) return { videoId, liked: true, already: true };
    await fp.act({ kind: "click" }, like, { goal: `like video ${videoId}` });
    if (!(await fp.has(liked, RENDER_MS)))
      return fp.human(`TikTok did not take the like on ${videoId}`);
    return { videoId, liked: true };
  },
});

const commentBox: Hints = { css: '[data-e2e="comment-text"] [contenteditable="true"]' };
const postButton: Hints = { css: '[data-e2e="comment-post"]' };

export const tiktokComment = defineFlow<
  VideoInput & { text: string },
  | { videoId: string; commented: true; id: string | null }
  | { found: false; status: number; reason: string }
>({
  site: "tiktok",
  name: "comment",
  async run(fp, { videoId, username, text }) {
    let answer: { code: number | null; id: string | null } | null = null;
    const onResponse = (r: Response) => {
      if (!r.url().includes(PUBLISH)) return;
      r.json().then(
        (b: { status_code?: number; comment?: { cid?: string } }) => {
          answer = { code: b.status_code ?? null, id: b.comment?.cid ?? null };
        },
        () => {
          answer = { code: null, id: null };
        },
      );
    };
    const opened = await openVideo(fp, videoId, username);
    if (!opened.opened) return { found: false, status: 404, reason: opened.reason };
    const tab = { role: "button", name: "/^comments$/i" } as const;
    let state = await videoShown(fp, [commentBox, tab]);
    if (state === "missing")
      return { found: false, status: 404, reason: `no TikTok video ${videoId}` };
    if (state === 1) {
      await fp.act({ kind: "click" }, tab, { goal: "show the comments panel" });
      state = (await fp.has(commentBox, RENDER_MS)) ? 0 : null;
    }
    // No box once the panel is open: comments are off, so this comment never goes.
    if (state === null)
      return { found: false, status: 403, reason: `comments are off on video ${videoId}` };
    await fp.act({ kind: "fill", value: text }, commentBox, { goal: "type the comment" });
    await fp.wait(SETTLE_MS);
    fp.page.on("response", onResponse);
    try {
      await fp.act({ kind: "click" }, postButton, {
        goal: `comment on video ${videoId}`,
        irreversible: true,
      });
      for (let i = 0; i < RENDER_MS / SETTLE_MS && !answer; i++) await fp.wait(SETTLE_MS);
    } finally {
      fp.page.off("response", onResponse);
    }
    const got = answer as { code: number | null; id: string | null } | null;
    if (got && got.code !== 0)
      return fp.human(`TikTok refused the comment on ${videoId} (status ${got.code ?? "unread"})`);
    // No answer read: the send may have gone; the route's verify reads the comments to tell.
    return { videoId, commented: true, id: got?.id ?? null };
  },
});

const followButton: Hints = { css: '[data-e2e="follow-button"]' };
const buttonText = async (fp: FlowPage) =>
  (await fp.has(followButton)) ? (await fp.read(followButton)).trim() : "";

export const tiktokFollow = defineFlow<
  { username: string },
  { username: string; following: true; already?: true } | { found: false; reason: string }
>({
  site: "tiktok",
  name: "follow",
  async run(fp, { username }) {
    const handle = username.replace(/^@/, "");
    const profile = `${WEB}/@${encodeURIComponent(handle)}`;
    await fp.open(profile);
    let shown = false;
    for (let i = 0; i < RENDER_MS / SETTLE_MS && !shown; i++) {
      shown = await fp.has(followButton);
      if (!shown && NO_ACCOUNT.test(await fp.text()))
        return { found: false, reason: `no TikTok account @${handle}` };
      if (!shown) await fp.wait(SETTLE_MS);
    }
    if (!shown) return fp.human(`no Follow button on @${handle} (${fp.url()})`);
    // Followed already: the button reads Following or Friends.
    if (!/^follow( back)?$/i.test((await fp.read(followButton)).trim()))
      return { username: handle, following: true, already: true };
    await fp.act({ kind: "click" }, followButton, { goal: `follow @${handle}` });
    let flipped = false;
    for (let i = 0; i < RENDER_MS / SETTLE_MS && !flipped; i++) {
      await fp.wait(SETTLE_MS);
      flipped = !/^follow( back)?$/i.test(await buttonText(fp));
    }
    if (!flipped) return fp.human(`TikTok did not take the follow of @${handle}`);
    // The button flips before TikTok answers, and a limited account gets it undone (2026-10-29:
    // a follow that read Following was gone on the next visit): a fresh load is the proof.
    await fp.wait(SETTLE_MS);
    await fp.open(profile);
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      const now = await buttonText(fp);
      if (now && !/^follow( back)?$/i.test(now)) return { username: handle, following: true };
      if (now) break;
      await fp.wait(SETTLE_MS);
    }
    return fp.human(`TikTok did not keep the follow of @${handle}: the account may be limited`);
  },
});
