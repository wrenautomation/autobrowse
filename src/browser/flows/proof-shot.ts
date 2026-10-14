/**
 * Proof a comment is up (wren designs/2026-10-14-comment-proof.md): open its permalink, find it,
 * and screenshot it with the post's title, as a JPEG the caller keeps. Runs signed out on `web`
 * (`GET /proof/shot`); the same route on `reddit` and `linkedin` runs as the chosen account, to
 * show what only its author sees.
 *
 * Finding the comment: Reddit's `ref` (`t1_…`) is `#thing_t1_…` on old.reddit and
 * `shreddit-comment[thingid=t1_…]` on www; anything else (LinkedIn) by its words, the smallest
 * element holding the first words of `text`, widened to its comment box. Not found, the shot is
 * the top of the page: what a stranger sees there.
 */
import type { Page } from "playwright";
import { defineFlow, type FlowPage } from "../flow.js";

const LAND_MS = 12_000;
const SETTLE_MS = 800;
/** A shot taller than this keeps the comment alone; the title still comes back as text. */
export const MAX_SHOT_H = 1_400;
const PAD = 8;
const QUALITY = 70;
/** The first words of a comment the page must hold to count as it. */
export const SNIPPET_CHARS = 80;
const WALL = /\/(login|authwall|checkpoint|signup)\b/i;

export interface ShotInput {
  url: string;
  /** The platform's id for the comment: Reddit's `t1_…`. */
  ref?: string;
  /** The comment's words, for a page with no id to find it by. */
  text?: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProofShot {
  /** The comment was on the page. */
  found: boolean;
  /** Where the page landed (a redirect, a login wall). */
  url: string;
  title: string | null;
  /** What the found comment reads, cut to 500 chars. */
  text: string | null;
  /** The shot, base64 JPEG. */
  jpeg: string;
  width: number;
  height: number;
}

/** Whitespace folded, lowercased, cut: what a page's words are matched by. */
export const snippetOf = (text: string, n = SNIPPET_CHARS): string =>
  text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, n).trim();

/**
 * The page area to keep: the title and the comment together when that fits `max`, else the
 * comment alone; padded, inside the page.
 */
export function clipOf(
  comment: Box,
  title: Box | null,
  page: { w: number; h: number },
  max = MAX_SHOT_H,
): Box {
  const both =
    title && title.h > 0
      ? {
          x: Math.min(title.x, comment.x),
          y: Math.min(title.y, comment.y),
          r: Math.max(title.x + title.w, comment.x + comment.w),
          b: Math.max(title.y + title.h, comment.y + comment.h),
        }
      : null;
  const one = {
    x: comment.x,
    y: comment.y,
    r: comment.x + comment.w,
    b: comment.y + Math.min(comment.h, max),
  };
  const pick = both && both.b - both.y <= max ? both : one;
  const x = Math.max(0, Math.floor(pick.x - PAD));
  const y = Math.max(0, Math.floor(pick.y - PAD));
  const r = Math.min(page.w, Math.ceil(pick.r + PAD));
  const b = Math.min(page.h, Math.ceil(pick.b + PAD));
  return { x, y, w: Math.max(1, r - x), h: Math.max(1, b - y) };
}

export interface Found {
  comment: Box | null;
  title: Box | null;
  titleText: string | null;
  text: string | null;
  page: { w: number; h: number };
}

/** Run in the page with `[ref, snippet]`: the comment's box, the title's box, in page pixels. */
export const FIND_SCRIPT = `(([ref, snippet]) => {
  const at = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } : null;
  };
  const union = (bs) => {
    const ok = bs.filter(Boolean);
    if (!ok.length) return null;
    const x = Math.min(...ok.map((b) => b.x)), y = Math.min(...ok.map((b) => b.y));
    const r = Math.max(...ok.map((b) => b.x + b.w)), bt = Math.max(...ok.map((b) => b.y + b.h));
    return { x, y, w: r - x, h: bt - y };
  };
  const fold = (s) => (s || "").replace(/\\s+/g, " ").trim();
  let el = null, box = null;
  if (ref) {
    const old = document.getElementById("thing_" + ref);
    if (old) { el = old.querySelector(":scope > .entry") || old; box = at(el); }
    const sh = !el && document.querySelector('shreddit-comment[thingid="' + ref + '"]');
    if (sh) {
      el = sh;
      const parts = [...sh.children].filter((k) => /^(commentMeta|comment|commentAvatar)$/.test(k.getAttribute("slot") || ""));
      box = union(parts.map(at)) || at(sh);
    }
  }
  if (!el && snippet) {
    let best = null;
    for (const c of document.querySelectorAll("p, span, div, article, li, section")) {
      const t = fold(c.innerText).toLowerCase();
      if (t.length < snippet.length || !t.includes(snippet)) continue;
      if (!best || t.length < best.len) best = { c, len: t.length };
    }
    if (best) {
      el = best.c.closest('article, li, [class*="comment" i]') || best.c;
      box = at(el) || at(best.c);
    }
  }
  const t = document.querySelector('#siteTable .thing.link a.title, shreddit-post h1, h1[slot="title"], [slot="title"], [data-test-id="main-feed-activity-card__commentary"], h1');
  const page = { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };
  return {
    comment: box,
    title: at(t),
    titleText: fold(t ? t.innerText : document.title).slice(0, 300) || null,
    text: el ? fold(el.innerText).slice(0, 500) : null,
    page,
  };
})`;

/** Sign-in sheets and cookie bars over the page: hidden so the shot shows what is under them. */
const UNCOVER = `(() => {
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    if (s.position !== "fixed" && s.position !== "sticky") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > vw * vh * 0.2 || /modal|consent|cookie|sign-in|signin|banner/i.test(el.className + " " + el.id))
      el.style.setProperty("display", "none", "important");
  }
  document.documentElement.style.setProperty("overflow", "auto", "important");
  document.body.style.setProperty("overflow", "auto", "important");
})()`;

/**
 * The comment's and title's boxes on the page as it is now. A string is evaluated as an
 * expression, never called with an argument, so the script is called in place.
 */
export const findOn = (page: Pick<Page, "evaluate">, ref: string | null, snippet: string | null) =>
  page.evaluate<Found>(`${FIND_SCRIPT}(${JSON.stringify([ref, snippet])})`);

async function find(fp: FlowPage, ref: string | null, snippet: string | null): Promise<Found> {
  const run = () => findOn(fp.page, ref, snippet);
  let found = await run();
  for (let t = 0; !found.comment && t < LAND_MS; t += SETTLE_MS) {
    await fp.wait(SETTLE_MS);
    found = await run();
  }
  return found;
}

export const proofShot = defineFlow<ShotInput, ProofShot>({
  site: "web",
  name: "proof-shot",
  async run(fp, input) {
    const ref = input.ref?.trim() || null;
    const snippet = input.text ? snippetOf(input.text) || null : null;
    if (!ref && !snippet) throw new Error("proof-shot: give ref or text");
    await fp.open(input.url, { allowWall: true });
    const landed = fp.url();
    await fp.page.keyboard.press("Escape").catch(() => undefined);
    const found = WALL.test(new URL(landed).pathname)
      ? { comment: null, title: null, titleText: null, text: null, page: { w: 0, h: 0 } }
      : await find(fp, ref, snippet);
    await fp.page.evaluate(UNCOVER).catch(() => undefined);
    const clip = found.comment ? clipOf(found.comment, found.title, found.page) : null;
    const shot = clip
      ? await fp.page.screenshot({
          type: "jpeg",
          quality: QUALITY,
          fullPage: true,
          clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h },
        })
      : await fp.page.screenshot({ type: "jpeg", quality: QUALITY });
    const view = fp.page.viewportSize();
    return {
      found: Boolean(found.comment),
      url: landed,
      title: found.titleText,
      text: found.text,
      jpeg: shot.toString("base64"),
      width: clip?.w ?? view?.width ?? 0,
      height: clip?.h ?? view?.height ?? 0,
    };
  },
});
