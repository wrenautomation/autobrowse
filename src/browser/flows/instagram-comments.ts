/**
 * The comments on any public Instagram post, read off the signed-in page. The Graph API reads
 * comments only on our own media, so wren finds its own comment on someone else's post here
 * (wren designs/2026-10-16-maybe-sent.md, `onpost:`).
 *
 * Mapped 2026-10-16 in explore on the instagram profile. The post page embeds its first comments
 * in a `script[data-sjs]` blob (Relay's prefetch: `xdt_api__v1__media__media_id__comments__connection`,
 * each node `{pk, text, created_at, user: {username, id}, parent_comment_id}`), about 14, in
 * Instagram's "popular" order, not newest first, with `page_info.has_next_page`. Scrolling the
 * comment column loads more by `PolarisPostCommentsPaginationQuery` on `/api/graphql`. The flow
 * keeps both, walking any JSON for comment nodes, so a moved key still reads.
 *
 * Read only: it opens the page and scrolls. It never clicks, likes, replies or types.
 */
import type { Response } from "playwright";
import { defineFlow } from "../flow.js";
import { igPostOf, type PostInput, postUrl } from "./instagram-act.js";
import { scrollList } from "./kit.js";

const RENDER_MS = 15_000;
const POLL_MS = 500;
const SETTLE_MS = 1_500;
const SCROLLS = 6;
/** Scrolls in a row that bring nothing new before the flow stops. */
const STILL_SCROLLS = 2;
export const MAX_IG_COMMENTS = 200;

const SIGNED_OUT = /\/accounts\/login\b/;
const MISSING = /sorry, this page isn.t available|the link you followed may be broken/i;
/** The top-level list; the child list (`…child_comments__connection`) carries replies. */
const TOP_LIST = "xdt_api__v1__media__media_id__comments__connection";
const CALLS = /instagram\.com\/(api\/graphql|graphql\/query)/;

export interface IgComment {
  /** The comment's `pk`. */
  id: string;
  username: string;
  /** The writer's Instagram id, when the page sent it. */
  userId: string | null;
  text: string;
  /** ISO time; "" when the page sent none. */
  at: string;
  /** The top-level comment a reply is under, else null. */
  parentId: string | null;
  likes: number | null;
  /** Written by the signed-in account (`viewer`). */
  mine: boolean;
}

export interface IgPostComments {
  shortcode: string;
  url: string;
  /** The post's owner, off its meta tags; null when the page gave none. */
  owner: string | null;
  /** The signed-in account's username, off the nav's Profile link; null when unread. */
  viewer: string | null;
  /** One row per id, newest first. Instagram sends them ranked, so this is not every comment. */
  comments: IgComment[];
  /** The page said it holds more than were read (`has_next_page` on the last list read). */
  more: boolean;
}

export interface IgCommentsInput extends PostInput {
  max?: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;
const idOf = (v: unknown): string | null => {
  const s = typeof v === "number" || typeof v === "string" ? String(v).trim() : "";
  return s && s !== "0" ? s : null;
};

/** One comment node, or null when this object is not one. */
function commentOf(n: Json): IgComment | null {
  const id = idOf(n.pk) ?? idOf(n.id);
  const user = isObj(n.user) ? n.user : null;
  const username = typeof user?.username === "string" ? user.username : null;
  if (!id || !username || typeof n.text !== "string") return null;
  const secs = Number(n.created_at);
  return {
    id,
    username,
    userId: idOf(user?.pk) ?? idOf(user?.id),
    text: n.text,
    at: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : "",
    parentId: idOf(n.parent_comment_id),
    likes: typeof n.comment_like_count === "number" ? n.comment_like_count : null,
    mine: false,
  };
}

/**
 * Every comment node in one JSON value, and the top-level list's `has_next_page` when it has
 * one. Only nodes under a key that names comments count, so a post's caption (the same shape,
 * under `caption`) never reads as one. A reply with no `parent_comment_id` takes its parent's.
 */
export function commentsIn(body: unknown): { comments: IgComment[]; more: boolean | null } {
  const comments: IgComment[] = [];
  let more: boolean | null = null;
  const walk = (v: unknown, parent: string | null, under: boolean) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, parent, under);
      return;
    }
    if (!isObj(v)) return;
    const row = under ? commentOf(v) : null;
    if (row) {
      comments.push(row.parentId || !parent ? row : { ...row, parentId: parent });
      // Replies a node carries (`preview_child_comments`, a child list) sit under it.
      for (const [k, x] of Object.entries(v)) if (/comment/i.test(k)) walk(x, row.id, true);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === TOP_LIST && isObj(x) && isObj(x.page_info))
        more = x.page_info.has_next_page === true;
      if (k === "caption") continue;
      walk(x, parent, under || /comment/i.test(k));
    }
  };
  walk(body, null, false);
  return { comments, more };
}

/** A Relay answer's JSON: `for (;;);` dropped, one value per line when it streams several. */
export function jsonsOf(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.replace(/^for \(;;\);/, "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // A cut line: skip it, the rest still reads.
    }
  }
  return out;
}

/** One row per id (the first seen wins), newest first; rows with no time last. */
export function mergeIgComments(rows: IgComment[]): IgComment[] {
  const seen = new Map<string, IgComment>();
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()].sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
}

/** The signed-in account: the nav's Profile link is `/<username>/`. */
const VIEWER_SCRIPT = `(() => {
  const a = Array.from(document.querySelectorAll("a[href]")).find(
    (el) => (el.textContent || "").trim() === "Profile",
  );
  return a ? a.getAttribute("href") : null;
})()`;

/** `/<username>/` as the username; null for any other link. */
export function viewerOf(href: string | null): string | null {
  return /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(href ?? "")?.[1] ?? null;
}

/** The page's prefetch blobs that hold comments, as text. */
const BLOBS_SCRIPT = `Array.from(document.querySelectorAll("script[data-sjs]"))
  .map((s) => s.textContent || "")
  .filter((t) => t.includes("${TOP_LIST}"))`;

/** Scrolls the post's comment column (a dialog's too) to its end; false when none scrolls. */
const SCROLL_SCRIPT = `(() => {
  const boxes = Array.from(document.querySelectorAll("main *, [role=dialog] *")).filter(
    (el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY),
  );
  boxes.forEach((el) => { el.scrollTop = el.scrollHeight; });
  return boxes.length > 0;
})()`;

export const instagramPostComments = defineFlow<
  IgCommentsInput,
  IgPostComments | { found: false; reason: string }
>({
  site: "instagram",
  name: "post-comments",
  async run(fp, { shortcode, max }) {
    if (!/^[\w-]{5,40}$/.test(shortcode)) return fp.human(`${shortcode} is not a post code`);
    const cap = Math.min(Math.max(1, max ?? 100), MAX_IG_COMMENTS);
    const rows: IgComment[] = [];
    let more = false;
    const take = (body: unknown) => {
      const got = commentsIn(body);
      rows.push(...got.comments);
      if (got.more !== null) more = got.more;
    };
    const pending: Array<Promise<void>> = [];
    const onResponse = (r: Response) => {
      if (!CALLS.test(r.url())) return;
      pending.push(
        r.text().then(
          (t) => {
            if (t.includes("comments__connection")) for (const j of jsonsOf(t)) take(j);
          },
          () => undefined,
        ),
      );
    };
    const settle = async () => {
      await fp.wait(SETTLE_MS);
      await Promise.all(pending);
    };
    const merged = () => mergeIgComments(rows);

    fp.page.on("response", onResponse);
    let owner: string | null = null;
    let viewer: string | null = null;
    try {
      await fp.open(postUrl(shortcode));
      if (SIGNED_OUT.test(fp.url()))
        return fp.human("Instagram is signed out on this profile: `autobrowse login instagram`");
      let rendered = false;
      for (let i = 0; i < RENDER_MS / POLL_MS; i++) {
        const post = igPostOf(await fp.html(), shortcode);
        if (post?.username) {
          owner = post.username;
          rendered = true;
          break;
        }
        if (MISSING.test(await fp.text()))
          return { found: false, reason: `no Instagram post ${shortcode}` };
        await fp.wait(POLL_MS);
      }
      if (!rendered) return fp.human(`post ${shortcode} did not render (${fp.url()})`);
      viewer = viewerOf(await fp.page.evaluate<string | null>(VIEWER_SCRIPT).catch(() => null));
      const blobs = await fp.page.evaluate<string[]>(BLOBS_SCRIPT).catch(() => [] as string[]);
      for (const b of blobs) for (const j of jsonsOf(b)) take(j);
      await Promise.all(pending);
      let still = 0;
      for (let i = 0; i < SCROLLS && more && still < STILL_SCROLLS; i++) {
        const before = merged().length;
        if (before >= cap) break;
        await scrollList(fp, SCROLL_SCRIPT);
        await settle();
        still = merged().length > before ? 0 : still + 1;
      }
      await Promise.all(pending);
    } finally {
      fp.page.off("response", onResponse);
    }
    const comments = merged().map((c) => ({ ...c, mine: !!viewer && c.username === viewer }));
    return {
      shortcode,
      url: postUrl(shortcode),
      owner,
      viewer,
      comments: comments.slice(0, cap),
      more: more || comments.length > cap,
    };
  },
});
