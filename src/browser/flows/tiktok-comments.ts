/**
 * The comments on one TikTok video, read from the page's own calls. TikTok has
 * no public comments API, and its comment markup carries no ids, so the flow
 * opens the video page and keeps the JSON the page fetches for itself:
 * `/api/comment/list/` (top level) and `/api/comment/list/reply/` (replies).
 *
 * It opens `/@<username>/video/<id>`; with no username it opens `/@_/video/<id>`
 * and counts on TikTok sending a wrong handle to the right one. It scrolls the
 * comment panel a few times for more, and clicks at most ten "View N replies"
 * buttons. Clicking to expand is the only act: it never likes, replies or
 * types. The page's own item data names the video's author, so the author's
 * comments come back marked `creator`. Bounded in time. Unproven live: no live
 * read was made.
 */
import type { Response } from "playwright";
import { defineFlow, type FlowPage } from "../flow.js";

const WEB = "https://www.tiktok.com";
const FIRST_MS = 15_000;
const TOTAL_MS = 60_000;
const POLL_MS = 500;
const SETTLE_MS = 1_500;
const SCROLLS = 6;
/** Scrolls in a row that bring nothing new before the flow stops scrolling. */
const STILL_SCROLLS = 2;
const REPLY_CLICKS = 10;
const CLICK_MS = 3_000;
export const MAX_COMMENTS = 100;

const LIST = "/api/comment/list/";
const REPLIES = /^View \d+ repl/i;
const GONE = /video currently unavailable|couldn.t find this video|this video is private/i;

export interface TikTokComment {
  id: string;
  text: string;
  /** ISO time; "" when TikTok sent none. */
  at: string;
  /** The writer's handle (`unique_id`). */
  author: string;
  authorName: string | null;
  authorId: string | null;
  /** The top-level comment's id for a reply, else null. */
  parentId: string | null;
  /** Written by the video's author. */
  creator: boolean;
  likes: number | null;
}

export interface PostComments {
  videoId: string;
  url: string;
  comments: TikTokComment[];
}

export interface PostCommentsInput {
  videoId: string;
  username?: string;
  max?: number;
}

/** One comment as TikTok's comment calls send it; only the fields read. */
interface RawComment {
  cid?: string | number;
  text?: string;
  create_time?: number | string;
  user?: { uid?: string | number; unique_id?: string; nickname?: string } | null;
  reply_id?: string | number;
  reply_to_reply_id?: string | number;
  digg_count?: number;
  label_list?: Array<{ type?: number; text?: string }> | null;
  is_author_digged?: boolean;
  reply_comment?: RawComment[] | null;
  reply_comment_total?: number;
}

const idOf = (v: unknown): string | null => {
  const s = typeof v === "number" || typeof v === "string" ? String(v).trim() : "";
  return s && s !== "0" ? s : null;
};

/** The video page; TikTok sends a wrong handle on to the right one. */
export function videoUrl(videoId: string, username?: string): string {
  const handle = (username ?? "").trim().replace(/^@/, "") || "_";
  return `${WEB}/@${encodeURIComponent(handle)}/video/${videoId}`;
}

/** The video author's id in the page's item data (`webapp.video-detail`), or null. */
export function videoAuthorIdIn(json: string | null): string | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as {
      __DEFAULT_SCOPE__?: Record<
        string,
        { itemInfo?: { itemStruct?: { author?: { id?: unknown } } } } | undefined
      >;
    };
    return idOf(data.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct?.author?.id);
  } catch {
    return null;
  }
}

/** The video's author wrote it: the same author id, or TikTok labels it Creator. */
export function isCreator(
  authorId: string | null,
  videoAuthorId: string | null,
  labels: RawComment["label_list"],
): boolean {
  if (authorId !== null && authorId === videoAuthorId) return true;
  return (labels ?? []).some((l) => /^creator$/i.test((l.text ?? "").trim()));
}

function rowOf(c: RawComment, videoAuthorId: string | null, parent: string | null) {
  const id = idOf(c.cid);
  if (!id) return null;
  const authorId = idOf(c.user?.uid);
  const secs = Number(c.create_time);
  const row: TikTokComment = {
    id,
    text: c.text ?? "",
    at: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : "",
    author: c.user?.unique_id ?? "",
    authorName: c.user?.nickname || null,
    authorId,
    // A reply names its top-level comment in `reply_id`; a top-level comment's is "0".
    parentId: idOf(c.reply_id) ?? parent,
    creator: isCreator(authorId, videoAuthorId, c.label_list),
    likes: typeof c.digg_count === "number" ? c.digg_count : null,
  };
  return row;
}

/**
 * Rows from one comment call's JSON: its `comments[]` and each one's
 * `reply_comment[]` preview. `parentId` is the top-level comment a reply call
 * was for, when the replies do not name it themselves.
 */
export function commentRows(
  body: unknown,
  videoAuthorId: string | null,
  parentId: string | null = null,
): TikTokComment[] {
  const list = (body as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(list)) return [];
  const out: TikTokComment[] = [];
  for (const c of list as RawComment[]) {
    const row = rowOf(c, videoAuthorId, parentId);
    if (!row) continue;
    out.push(row);
    for (const r of c.reply_comment ?? []) {
      const reply = rowOf(r, videoAuthorId, row.id);
      if (reply) out.push(reply);
    }
  }
  return out;
}

/** One row per id (the first seen wins), newest first; rows with no time last. */
export function mergeComments(rows: TikTokComment[]): TikTokComment[] {
  const seen = new Map<string, TikTokComment>();
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()].sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
}

/** The top-level comment a reply call asks about (`comment_id`), or null. */
export function replyParentOf(url: string): string | null {
  try {
    return idOf(new URL(url).searchParams.get("comment_id"));
  } catch {
    return null;
  }
}

/** Scrolls the first comment panel that can scroll to its end; false when none can. */
const SCROLL_SCRIPT = `(() => {
  const boxes = Array.from(document.querySelectorAll('[class*="CommentList"], [class*="comment-list"]'));
  const box = boxes.find((el) => el.scrollHeight > el.clientHeight + 10);
  if (!box) return false;
  box.scrollTop = box.scrollHeight;
  return true;
})()`;
/** The page's own item data, as text. */
const DATA_SCRIPT = `document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent ?? null`;

/** Scroll the comment panel to its end; the page itself when no panel scrolls. */
async function scrollComments(fp: FlowPage): Promise<void> {
  const moved = await fp.page.evaluate<boolean>(SCROLL_SCRIPT).catch(() => false);
  if (!moved) await fp.scroll(1_500);
}

export const tiktokPostComments = defineFlow<PostCommentsInput, PostComments>({
  site: "tiktok",
  name: "post-comments",
  async run(fp, { videoId, username, max }) {
    if (!/^\d+$/.test(videoId)) return fp.human(`${videoId} is not a TikTok video id`);
    const cap = Math.min(Math.max(1, max ?? 50), MAX_COMMENTS);
    const bodies: Array<{ body: unknown; parent: string | null }> = [];
    const pending: Array<Promise<void>> = [];
    const onResponse = (r: Response) => {
      const u = r.url();
      if (!u.includes(LIST)) return;
      const parent = u.includes(`${LIST}reply/`) ? replyParentOf(u) : null;
      pending.push(
        r.json().then(
          (body: unknown) => {
            bodies.push({ body, parent });
          },
          () => undefined,
        ),
      );
    };
    let authorId: string | null = null;
    const rows = () =>
      mergeComments(bodies.flatMap((b) => commentRows(b.body, authorId, b.parent)));
    const settle = async () => {
      await fp.wait(SETTLE_MS);
      await Promise.all(pending);
    };

    fp.page.on("response", onResponse);
    try {
      const started = Date.now();
      const left = () => TOTAL_MS - (Date.now() - started);
      await fp.open(videoUrl(videoId, username));
      for (let waited = 0; !bodies.length && waited < FIRST_MS; waited += POLL_MS) {
        await Promise.all(pending);
        if (bodies.length) break;
        await fp.wait(POLL_MS);
      }
      if (!bodies.length) {
        if (GONE.test(await fp.text())) return fp.human(`${fp.url()}: the video is not there`);
        return fp.human(`${fp.url()} made no comment call: the page may not show its comments`);
      }
      authorId = videoAuthorIdIn(
        await fp.page.evaluate<string | null>(DATA_SCRIPT).catch(() => null),
      );
      let still = 0;
      for (let i = 0; i < SCROLLS && still < STILL_SCROLLS && left() > 0; i++) {
        const before = rows().length;
        if (before >= cap) break;
        await scrollComments(fp);
        await settle();
        still = rows().length > before ? 0 : still + 1;
      }
      for (let i = 0; i < REPLY_CLICKS && left() > 0; i++) {
        const more = fp.page.getByText(REPLIES).first();
        if (!(await more.isVisible().catch(() => false))) break;
        const clicked = await more.click({ timeout: CLICK_MS }).then(
          () => true,
          () => false,
        );
        if (!clicked) break;
        await settle();
      }
      await Promise.all(pending);
    } finally {
      fp.page.off("response", onResponse);
    }
    return { videoId, url: fp.url(), comments: rows().slice(0, cap) };
  },
});
