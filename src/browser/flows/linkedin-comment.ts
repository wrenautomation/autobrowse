/**
 * LinkedIn comments through the signed-in page, in the Community Management API's shapes, until
 * that review passes (`w_organization_social`/`r_organization_social`, src/sites/linkedin.ts).
 * Run as linkedin@wren only; capped per account.
 *
 * Mapped 2026-10-13 in explore as linkedin@wren. `/feed/update/<urn>/?actorCompanyId=<page>`
 * acts as the Page: the box reads "Comment as <Page>" (else "Add a comment..."), a reply box
 * "Reply as <Page>". The box is a tiptap editor that takes `fill`, one `<p>` per line. Its submit
 * is the label-less "Comment" button ("Reply" under a comment); the bar's own Comment and every
 * comment's Reply carry an aria-label. Each comment is `[id="replaceableComment_urn:li:comment:
 * (activity:1,2)"]`, replies flat beside it, 40px in, under the top comment before them. The list
 * is lazy: scrolling to its last comment loads more. A comment id carries its time (id >> 22, ms).
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_000;
const MISSING = /this page doesn.t exist|page not found|this post (?:cannot|can.t) be displayed/i;

/** `urn:li:comment:(urn:li:activity:1,2)`, as the API writes it. */
const API_COMMENT = /^urn:li:comment:\(urn:li:([a-zA-Z]+):(\d+),(\d+)\)$/;
/** The same comment as the page writes it: `urn:li:comment:(activity:1,2)`. */
const PAGE_COMMENT = /replaceableComment_urn:li:comment:\(([a-zA-Z]+):(\d+),(\d+)\)/g;

const box: Hints = { css: "[contenteditable=true]" };
const asPage: Hints = { css: '[contenteditable=true] [data-placeholder^="Comment as "]' };
const asMember: Hints = { css: '[contenteditable=true] [data-placeholder^="Add a comment"]' };
const submit = (label: "Comment" | "Reply"): Hints => ({
  css: `button:not([aria-label]):has-text("${label}")`,
});

/** When LinkedIn made the id: its top bits are milliseconds since 1970. */
export const timeOfId = (id: string): number => Number(BigInt(id) >> 22n);

/** The post a comment is on and the comment's own id, or the post itself. */
export function targetOf(urn: string): { post: string; comment: string | null } {
  const m = API_COMMENT.exec(urn);
  return m
    ? { post: `urn:li:${m[1]}:${m[2]}`, comment: m[3] as string }
    : { post: urn, comment: null };
}

const postUrl = (post: string, page?: string) =>
  `${WEB}/feed/update/${post}/${page ? `?actorCompanyId=${encodeURIComponent(page)}` : ""}`;

/** Every comment on the page, in the API's URN form. */
export function commentUrnsOf(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(PAGE_COMMENT))
    out.add(`urn:li:comment:(urn:li:${m[1]}:${m[2]},${m[3]})`);
  return [...out];
}

async function ready(
  fp: FlowPage,
  url: string,
  what: string,
): Promise<null | { found: false; reason: string }> {
  await go(fp, url);
  for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
    if (await fp.has(box)) return null;
    if (MISSING.test(await fp.text())) return { found: false, reason: `no LinkedIn post ${what}` };
    await fp.wait(SETTLE_MS);
  }
  return fp.human(`no comment box under ${what} (${fp.url()})`);
}

/** The editor's text, one line per paragraph; null when it holds anything else (a fake page). */
async function typed(fp: FlowPage, nth: number): Promise<string | null> {
  try {
    return await fp.page
      .locator("[contenteditable=true]")
      .nth(nth)
      .evaluate(
        (el) => {
          type Kid = { tagName: string; textContent: string | null };
          const kids = Array.from((el as unknown as { children: ArrayLike<Kid> }).children);
          return kids.length && kids.every((k) => k.tagName === "P")
            ? kids.map((k) => k.textContent ?? "").join("\n")
            : null;
        },
        undefined,
        { timeout: 5_000 },
      );
  } catch {
    return null;
  }
}

/** Every comment on the page, and its author link: run in the page. */
const COMMENTS = '[id^="replaceableComment_urn:li:comment:("]';

/** Scroll to the last comment so the lazy list loads the next ones. */
async function more(fp: FlowPage): Promise<void> {
  try {
    await fp.page.evaluate(`(() => {
      const all = document.querySelectorAll(${JSON.stringify(COMMENTS)});
      if (all.length) all[all.length - 1].scrollIntoView({ block: "end" });
    })()`);
  } catch {
    // A page without the list (a fake) has nothing more to load.
  }
  await fp.wait(2 * SETTLE_MS);
}

/**
 * The Reply button under one comment, found by the comment's own id. The page keys a comment by
 * the post's activity id, while the urn may name the post as a share or ugcPost (another id), so
 * the post half of the element id is never matched (2026-10-17: a share urn found no comment).
 */
export const replyButtonCss = (comment: string): string =>
  `[id^="replaceableComment_urn:li:comment:("][id$=",${comment})"] button[aria-label="Reply"]`;

export interface CommentInput {
  /** The post, or (a reply) the comment, `urn:li:comment:(urn:li:activity:1,2)`. */
  urn: string;
  text: string;
  /** Who comments, as the API names it: a Page's or a member's URN. */
  actor: string;
  /** A Page's numeric id to comment as; none comments as the member. */
  page?: string;
}

export interface CreatedComment {
  id?: string;
  commentUrn: string | null;
  $URN?: string;
  actor: string;
  object: string;
  parentComment?: string;
  message: { text: string };
  created?: { time: number };
}

export const linkedinComment = defineFlow<
  CommentInput,
  CreatedComment | { found: false; reason: string }
>({
  site: "linkedin",
  name: "comment",
  async prepare(fp, { urn, page }) {
    const { post } = targetOf(urn);
    await ready(fp, postUrl(post, page), urn);
  },
  async run(fp, { urn, text, actor, page }) {
    const { post, comment } = targetOf(urn);
    const no = await ready(fp, postUrl(post, page), urn);
    if (no) return no;
    // The page says who comments before anything is typed.
    if (page && !(await fp.has(asPage, RENDER_MS)))
      return fp.human(`the comment box does not act as Page ${page} (${fp.url()})`);
    if (!page && !(await fp.has(asMember, RENDER_MS)))
      return fp.human(`the comment box acts as someone other than the member (${fp.url()})`);
    let nth = 0;
    if (comment) {
      const reply: Hints = { css: replyButtonCss(comment) };
      for (let i = 0; i < 10 && !(await fp.has(reply, 2_000)); i++) await more(fp);
      if (!(await fp.has(reply))) return { found: false, reason: `no LinkedIn comment ${urn}` };
      await fp.act({ kind: "click" }, reply, { goal: `open a reply to ${urn}` });
      nth = 1;
      if (!(await fp.has({ ...box, nth }, RENDER_MS))) return fp.human(`no reply box under ${urn}`);
    }
    const into: Hints = { ...box, nth };
    const before = new Set(commentUrnsOf(await fp.html()));
    await fp.act({ kind: "fill", value: text }, into, {
      goal: comment ? "type the reply" : "type the comment",
    });
    await fp.wait(SETTLE_MS);
    const got = await typed(fp, nth);
    if (got !== null && got !== text.replace(/\n+$/, ""))
      return fp.human(
        `the comment box holds other text than the comment (${got.length} vs ${text.length} chars)`,
      );
    await fp.act({ kind: "click" }, submit(comment ? "Reply" : "Comment"), {
      goal: comment ? `reply to ${urn}` : `comment on ${post}`,
      irreversible: true,
    });
    const shape = {
      actor,
      object: post,
      message: { text },
      ...(comment ? { parentComment: urn } : {}),
    };
    for (let i = 0; i < RENDER_MS / SETTLE_MS; i++) {
      await fp.wait(SETTLE_MS);
      const html = await fp.html();
      if (/couldn.t (?:post|add) (?:your )?comment|something went wrong/i.test(await fp.text()))
        return fp.human(`LinkedIn did not take the comment on ${post}`);
      const fresh = commentUrnsOf(html).find((u) => !before.has(u));
      if (fresh) {
        const id = targetOf(fresh).comment as string;
        return { id, commentUrn: fresh, $URN: fresh, ...shape, created: { time: timeOfId(id) } };
      }
    }
    // Sent, as far as the page says, but the new comment never rendered: no URN to keep.
    return { commentUrn: null, ...shape };
  },
});

/** One comment as the page shows it, read in the browser. */
export interface RawComment {
  /** `activity:1,2` out of the element's id. */
  ref: string;
  /** Left edge of its author link: a reply sits further in. */
  left: number;
  href: string | null;
  name: string | null;
  text: string;
}

export interface CommentElement {
  id: string;
  commentUrn: string;
  $URN: string;
  actor: string;
  actorName?: string;
  object: string;
  parentComment?: string;
  message: { text: string };
  created: { time: number };
}

/**
 * The page's comments in the API's shape. A company link is the Page's URN when its handle is
 * one of `pages` (handle to id) or numeric; anything else, a member included, stays its profile
 * URL: the page never shows a member's URN.
 */
export function commentElements(
  raw: RawComment[],
  pages: Record<string, string> = {},
): CommentElement[] {
  const top = Math.min(...raw.map((r) => r.left));
  let parent: string | undefined;
  return raw.flatMap((r) => {
    const m = /^([a-zA-Z]+):(\d+),(\d+)$/.exec(r.ref);
    if (!m) return [];
    const [, kind, post, id] = m as unknown as [string, string, string, string];
    const urn = `urn:li:comment:(urn:li:${kind}:${post},${id})`;
    const reply = r.left > top + 8 && parent !== undefined;
    if (!reply) parent = urn;
    const company = /\/company\/([^/?#]+)/.exec(r.href ?? "")?.[1];
    const page = company && (/^\d+$/.test(company) ? company : pages[company.toLowerCase()]);
    return [
      {
        id,
        commentUrn: urn,
        $URN: urn,
        actor: page ? `urn:li:organization:${page}` : (r.href?.split("?")[0] ?? ""),
        ...(r.name ? { actorName: r.name } : {}),
        object: `urn:li:${kind}:${post}`,
        ...(reply && parent ? { parentComment: parent } : {}),
        message: { text: r.text.replace(/\s*…\s*more\s*$/, "").trim() },
        created: { time: timeOfId(id) },
      },
    ];
  });
}

/** Each comment's id, author link (and how far in it sits), name and words. */
export const READ_COMMENTS = `(() => [...document.querySelectorAll(${JSON.stringify(COMMENTS)})].map((c) => {
  const a = c.querySelector('a[href*="/in/"], a[href*="/company/"]');
  const opts = [...c.querySelectorAll("button")].find((b) => /^View more options for /.test(b.getAttribute("aria-label") || ""));
  const name = /^View more options for (.+?)(?:’s|'s|’|')? comment/.exec(opts ? opts.getAttribute("aria-label") : "");
  const box = c.querySelector('[data-testid="expandable-text-box"]');
  return {
    ref: c.id.replace(/^replaceableComment_urn:li:comment:\\(/, "").replace(/\\)$/, ""),
    left: a ? Math.round(a.getBoundingClientRect().left) : 0,
    href: a ? a.getAttribute("href") : null,
    name: name ? name[1] : null,
    text: box ? box.innerText : "",
  };
}))()`;

async function rawComments(fp: FlowPage): Promise<RawComment[]> {
  try {
    return await fp.page.evaluate<RawComment[]>(READ_COMMENTS);
  } catch {
    return [];
  }
}

export interface PostCommentsInput {
  urn: string;
  count: number;
  start: number;
  /** Page handles to their ids (`wrenautomation` → `143656154`), so a Page's comments name its URN. */
  pages?: Record<string, string>;
}

export const linkedinPostComments = defineFlow<
  PostCommentsInput,
  | { elements: CommentElement[]; paging: { start: number; count: number } }
  | { found: false; reason: string }
>({
  site: "linkedin",
  name: "post-comments",
  async run(fp, { urn, count, start, pages }) {
    const no = await ready(fp, postUrl(urn), urn);
    if (no) return no;
    let raw = await rawComments(fp);
    for (let still = 0; raw.length < start + count && still < 2; ) {
      await more(fp);
      const next = await rawComments(fp);
      still = next.length > raw.length ? 0 : still + 1;
      raw = next;
    }
    return {
      elements: commentElements(raw, pages).slice(start, start + count),
      paging: { start, count },
    };
  },
});
