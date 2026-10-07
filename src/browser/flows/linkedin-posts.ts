/**
 * Recent posts by others, for wren's comment loop: a content search for a
 * keyword, or a company's Posts tab. Read only: it opens one page and
 * scrolls; on the Posts tab it also picks "Sort by: Recent". It never clicks
 * a post, a reaction, follow or connect.
 *
 * A post is only worth reading here with its urn (the comment route needs
 * one), so a card that names none is dropped and counted. The urn comes from,
 * first to last: a `data-urn` or `data-id` on or inside the card, any other
 * attribute naming `urn:li:(activity|ugcPost|share):N`, LinkedIn's own state
 * keys on the card's buttons, the comment box's componentkey, or a
 * `/feed/update/urn:li:…` link.
 *
 * Two layouts. Classic: `div.feed-shared-update-v2[data-urn]` with
 * `.update-components-actor__*` for the author and `.update-components-text`
 * for the body, social counts under it. SDUI (mapped 2026-10-06 on activity
 * pages, see linkedin-activity.ts; 2026-10-07 in explore as linkedin@wren on
 * the content search and a company's Posts tab, both SDUI):
 * `[componentkey^="update-card-focus"]` cards, `[data-testid="expandable-text-box"]`
 * body (its full text, then "… more"), reaction and comment buttons holding
 * the counts. An SDUI card names no urn in its markup. Two places do:
 * - The action buttons' React props carry the server's state keys,
 *   `reactionsCount-urn:li:activity:N` (also `commentCount-`, `repostCount-`):
 *   the payload the page was rendered from, read in place.
 * - The comment box's componentkey starts with a base64 protobuf,
 *   `CgsI…-replaceableCommentTools<hash>`: field 1 holds an activity id,
 *   field 2 a ugcPost id, each a zigzag varint in its field 1. Both agreed
 *   on every card read 2026-10-07; it is the fallback when React's props
 *   are out of reach.
 * The search's results come in the document and then as RSC streams
 * (`/flagship-web/rsc-action/actions/pagination`), not voyager JSON: no
 * JSON call to read instead. The Posts tab ignores `sortBy` in its URL
 * (it opens on "Top"), so the flow picks Recent in its menu.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import type { Hints } from "../locate.js";
import { scrollCollect } from "../scroll-collect.js";
import { AGE_LINE, FEED_URN, HEADER, linesOf } from "./linkedin-activity.js";
import { ageAt } from "./linkedin-notifications.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";
const CARD = "main div.feed-shared-update-v2, main [componentkey^='update-card-focus']";
const RENDER_MS = 15_000;
// "No results found" is the search page's; the company phrases are guesses.
const EMPTY = /no results found|hasn.t posted yet|no posts yet/i;

/** A named profile or company link on a card. */
export interface RawActor {
  name: string;
  url: string;
}

/** A card as the page holds it. Counts stay text ("1,234", "2K") until `postOf`. */
export interface RawPost {
  layout: "classic" | "sdui";
  /** Attribute values on or inside the card that name a post urn: data-urn and data-id first. */
  ids: string[];
  /** SDUI: the state keys in the action buttons' React props (`reactionsCount-urn:li:activity:N`). */
  state?: string[];
  /** SDUI: the comment box's componentkey (`CgsI…-replaceableCommentTools<hash>`). */
  tools?: string[];
  text: string;
  links: string[];
  /** Named author links in page order (a repost's header names the reposter first). */
  actors: RawActor[];
  /** Classic only: the actor description and the age line. */
  headline?: string;
  sub?: string;
  body?: string;
  reactions: string;
  comments: string;
}

export interface FeedPost {
  /** `urn:li:activity:N`, `urn:li:ugcPost:N` or `urn:li:share:N`. */
  urn: string;
  author: string;
  /** `https://www.linkedin.com/in/<vanity>/`, `/company/<handle>/` or a showcase or school page, query stripped. */
  authorUrl: string | null;
  headline?: string;
  text: string;
  /** The page's age label ("2h"), and the instant it reads as at the read. */
  age?: string;
  at?: string;
  approx?: true;
  reactions: number;
  comments: number;
  url: string;
  raw: RawPost;
}

const POST_URN = /urn:li:(?:activity|ugcPost|share):\d+/;
const AUTHOR_URL =
  /^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(in|company|showcase|school)\/([^/?#]+)/i;
/** Lines between the author and the headline: degree, follow state. */
const NOT_HEADLINE = /^([•·]|follow(ing)?$|\d(st|nd|rd)\b|premium$|verified$)/i;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** "1,234" → 1234, "2K" → 2000, "1.5M" → 1500000, "12 comments" → 12; 0 when no number. */
export function countOf(text: string | undefined): number {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([KM])?/i.exec(text ?? "");
  if (!m?.[1]) return 0;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1;
  return Math.round(Number(m[1].replace(/,/g, "")) * mult);
}

/** A profile or company page, bare: `https://www.linkedin.com/in/<vanity>/`; null for anything else. */
export function authorUrlOf(url: string | undefined): string | null {
  const m = AUTHOR_URL.exec(url ?? "");
  return m ? `${WEB}/${(m[1] ?? "").toLowerCase()}/${m[2]}/` : null;
}

/** The protobuf fields of a comment box's componentkey: which post kind each holds. */
const TOOLS_KINDS: Record<number, string> = { 1: "activity", 2: "ugcPost" };

/**
 * `CgsIgsCzsLPL1cXQAQ-replaceableCommentTools<hash>` → `urn:li:activity:N`: the
 * base64 before the dash is one length-delimited field (1 = activity, 2 =
 * ugcPost) holding the id as a zigzag varint in its field 1. Null for any other shape.
 */
export function urnOfTools(key: string): string | null {
  const m = /^([A-Za-z0-9+/_-]+={0,2})-replaceableCommentTools/.exec(key);
  if (!m?.[1]) return null;
  const b = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const kind = TOOLS_KINDS[(b[0] ?? 0) >> 3];
  // Wire type 2 outside, then field 1 wire type 0 (the varint) inside.
  if (!kind || ((b[0] ?? 0) & 7) !== 2 || b[2] !== 0x08) return null;
  let v = 0n;
  let shift = 0n;
  for (let i = 3; i < b.length && shift < 70n; i++, shift += 7n) {
    const x = b[i] ?? 0;
    v |= BigInt(x & 0x7f) << shift;
    if (!(x & 0x80)) {
      // Zigzag: an id is never negative, so its encoding is even.
      return v > 0n && !(v & 1n) ? `urn:li:${kind}:${v >> 1n}` : null;
    }
  }
  return null;
}

/**
 * The post's urn: the card's attributes, LinkedIn's state keys, the comment
 * box's componentkey, then its feed links; null when it names none.
 */
export function urnOf(raw: Pick<RawPost, "ids" | "links" | "state" | "tools">): string | null {
  for (const v of [...raw.ids, ...(raw.state ?? [])]) {
    const m = POST_URN.exec(v);
    if (m) return m[0];
  }
  for (const k of raw.tools ?? []) {
    const urn = urnOfTools(k);
    if (urn) return urn;
  }
  for (const l of raw.links) {
    const m = FEED_URN.exec(decode(l));
    if (m?.[1]) return m[1];
  }
  return null;
}

/** The body as written: the SDUI box ends with its "… more" button. */
const bodyOf = (body: string | undefined) =>
  (body ?? "").replace(/\s*(?:…|\.\.\.)\s*(?:see )?more\s*$/i, "").trim();

/** "Jane Doe • 3rd+" → "Jane Doe". */
const nameOf = (s: string) => (s.split("\n")[0] ?? "").replace(/\s*[•·].*$/, "").trim();

/** One card as a post; null when it names no post urn. */
export function postOf(raw: RawPost, now: Date): FeedPost | null {
  const urn = urnOf(raw);
  if (!urn) return null;
  const lines = linesOf(raw.text);
  // A repost's header ("<name> reposted this") names the reposter before the author.
  const header = lines.slice(0, 2).find((l) => HEADER.test(l));
  const reposter = (a: RawActor) => {
    const n = nameOf(a.name);
    return !!header && !!n && header !== n && header.includes(n);
  };
  const actor = raw.actors.find((a) => !reposter(a)) ?? raw.actors[0];
  const author = actor ? nameOf(actor.name) : "";
  const ageLines = raw.sub ? linesOf(raw.sub) : lines;
  const age = ageLines.map((l) => AGE_LINE.exec(l)?.[1]).find(Boolean);
  const at = age ? ageAt(age, now) : null;
  const headline = raw.headline ? linesOf(raw.headline)[0] : headlineAfter(lines, author);
  return {
    urn,
    author,
    authorUrl: authorUrlOf(actor?.url),
    ...(headline ? { headline } : {}),
    text: bodyOf(raw.body),
    ...(age ? { age } : {}),
    ...(at ? { at, approx: true as const } : {}),
    reactions: countOf(raw.reactions),
    comments: countOf(raw.comments),
    url: `${WEB}/feed/update/${urn}/`,
    raw,
  };
}

/** SDUI: the first line after the author's that is not a degree, follow state or the age. */
function headlineAfter(lines: string[], author: string): string | undefined {
  const i = author ? lines.findIndex((l) => nameOf(l) === author) : -1;
  if (i < 0) return undefined;
  for (const l of lines.slice(i + 1)) {
    if (NOT_HEADLINE.test(l) || nameOf(l) === author) continue;
    return AGE_LINE.test(l) ? undefined : l;
  }
  return undefined;
}

/**
 * The page script: every outermost card on screen as a RawPost. A string, not
 * a function: tsx wraps named helpers in `__name`, which the page lacks.
 */
export const READ_POSTS = `(() => {
  const CARD = ${JSON.stringify(CARD.replace(/main /g, ""))};
  const URN = /urn:li:(?:activity|ugcPost|share):\\d+/;
  const CMT = '[componentkey^="replaceableComment_"], .comments-comments-list, .comments-comment-entity';
  const AUTHOR = /linkedin\\.com\\/(in|company|showcase|school)\\//;
  const outside = (card, el) => !el.closest(CMT) || !card.contains(el.closest(CMT));
  const first = (card, sel) => [...card.querySelectorAll(sel)].find((e) => outside(card, e)) || null;
  const text = (el) => (el ? el.innerText.trim() : "");
  // The first of these that holds a number: its text, else its aria-label.
  const count = (card, sels) => {
    for (const sel of sels)
      for (const el of card.querySelectorAll(sel)) {
        if (!outside(card, el)) continue;
        const t = text(el) || el.getAttribute("aria-label") || "";
        if (/\\d/.test(t)) return t;
      }
    return "";
  };
  const ids = (card) => {
    const keyed = [card, ...card.querySelectorAll("[data-urn], [data-id]")]
      .flatMap((el) => [el.getAttribute("data-urn"), el.getAttribute("data-id")])
      .filter((v) => v && URN.test(v));
    const rest = [card, ...card.querySelectorAll("*")].flatMap((el) =>
      [...el.attributes].filter((a) => a.name !== "href" && URN.test(a.value)).map((a) => a.value));
    return [...new Set([...keyed, ...rest])];
  };
  // LinkedIn's state keys ("reactionsCount-urn:li:activity:N") in the action buttons' React props.
  const STATE = /^[A-Za-z]+-urn:li:(?:activity|ugcPost|share):\\d+$/;
  const state = (card) => {
    const out = new Set();
    for (const el of card.querySelectorAll("button")) {
      if (!outside(card, el)) continue;
      const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
      if (!key) continue;
      const seen = new Set();
      const walk = (o, depth) => {
        if (!o || typeof o !== "object" || depth > 12 || seen.has(o) || o instanceof Node || seen.size > 2000) return;
        seen.add(o);
        for (const k of Object.keys(o)) {
          if (k === "_owner" || k === "_store") continue;
          const v = o[k];
          if (typeof v === "string") { if (STATE.test(v)) out.add(v); }
          else walk(v, depth + 1);
        }
      };
      walk(el[key], 0);
      if (out.size) break;
    }
    return [...out];
  };
  const tools = (card) => [...card.querySelectorAll('[componentkey*="-replaceableCommentTools"]')]
    .filter((el) => outside(card, el))
    .map((el) => el.getAttribute("componentkey"));
  const main = document.querySelector("main") || document;
  return [...main.querySelectorAll(CARD)]
    .filter((card) => !(card.parentElement && card.parentElement.closest(CARD)))
    .map((card) => {
      const classic = card.matches(".feed-shared-update-v2");
      const links = [...card.querySelectorAll("a[href]")].map((a) => a.href);
      const base = { ids: ids(card), text: card.innerText, links };
      if (classic) {
        const title = card.querySelector(".update-components-actor__title");
        const named = title && (title.querySelector("span[aria-hidden=true]") || title);
        const link = card.querySelector("a.update-components-actor__meta-link, .update-components-actor__container a[href], a.update-components-actor__image");
        const headline = text(card.querySelector(".update-components-actor__description"));
        const sub = text(card.querySelector(".update-components-actor__sub-description"));
        const body = text(card.querySelector(".update-components-text"));
        return {
          layout: "classic",
          ...base,
          actors: named && text(named) ? [{ name: text(named), url: link ? link.href : "" }] : [],
          ...(headline ? { headline } : {}),
          ...(sub ? { sub } : {}),
          ...(body ? { body } : {}),
          reactions: count(card, [".social-details-social-counts__reactions-count", ".social-details-social-counts__social-proof-fallback-number", "[aria-label*='reaction']"]),
          comments: count(card, [".social-details-social-counts__comments", "[aria-label*='comment']"]),
        };
      }
      const actors = [];
      for (const a of card.querySelectorAll("a[href]")) {
        const name = text(a);
        if (outside(card, a) && AUTHOR.test(a.href) && name && !actors.some((x) => x.url === a.href))
          actors.push({ name, url: a.href });
      }
      const body = text(first(card, '[data-testid="expandable-text-box"]'));
      return {
        layout: "sdui",
        ...base,
        state: state(card),
        tools: tools(card),
        actors,
        ...(body ? { body } : {}),
        reactions: count(card, ["button[aria-label^='Reaction button state']"]),
        comments: count(card, ["button[aria-label='Comment']"]),
      };
    });
})()`;

export type PostsSince = "past-24h" | "past-week" | "past-month";

export interface SearchPostsInput {
  keywords: string;
  /** How many from the top, newest first (default 20). */
  max?: number;
  since?: PostsSince;
}

export interface CompanyPostsInput {
  company: string;
  max?: number;
}

export interface Posts {
  posts: FeedPost[];
  /** Cards that named no post urn. */
  dropped: number;
}

/** LinkedIn's own query: filters quoted (`datePosted="past-week"`), newest first. */
export const postsSearchUrl = (keywords: string, since: PostsSince = "past-week"): string => {
  const u = new URL(`${WEB}/search/results/content/`);
  u.searchParams.set("keywords", keywords);
  u.searchParams.set("datePosted", JSON.stringify(since));
  u.searchParams.set("sortBy", JSON.stringify("date_posted"));
  return u.toString();
};

/**
 * The Posts tab. `feedView=all` is the tab's own link (all posts, not just
 * articles or videos). It opens sorted by Top whatever the URL says
 * (`sortBy=recent` is dropped by a redirect), so `sortRecent` picks Recent.
 */
export const companyPostsUrl = (company: string): string => {
  const id = /\/company\/([^/?#]+)/.exec(company)?.[1] ?? company;
  return `${WEB}/company/${encodeURIComponent(decode(id))}/posts/?feedView=all`;
};

const SORT_TOP: Hints = { role: "button", name: "/^sort by:\\s*top$/i" };
const SORT_RECENT: Hints = { role: "button", name: "/^sort by:\\s*recent$/i" };
const RECENT: Hints = { role: "menuitem", name: "/^recent$/i" };

/** The Posts tab's "Sort by: Top" menu set to Recent; a page without the menu is read as it is. */
async function sortRecent(fp: FlowPage): Promise<void> {
  if (!(await fp.has(SORT_TOP, 3_000))) return;
  await fp.act({ kind: "click" }, SORT_TOP, { goal: "open the posts' sort menu" });
  await fp.act({ kind: "click" }, RECENT, { goal: "sort the posts by recent" });
  await fp.has(SORT_RECENT, RENDER_MS);
  await fp.has({ css: CARD }, RENDER_MS);
}

/**
 * One page's posts, read by scrolling; none when the page says it is empty.
 * `ready` runs once the first cards show (the Posts tab's sort).
 */
export async function readPosts(
  fp: FlowPage,
  url: string,
  max: number,
  ready?: (fp: FlowPage) => Promise<void>,
): Promise<Posts> {
  await go(fp, url);
  if (!(await fp.has({ css: CARD }, RENDER_MS))) {
    if (EMPTY.test(await fp.text())) return { posts: [], dropped: 0 };
    return fp.human(`no post list at ${fp.url()}`);
  }
  await ready?.(fp);
  const now = new Date();
  // Dropped cards have no urn to key on: their opening text stands in, so a card seen twice counts once.
  const dropped = new Set<string>();
  const { rows } = await scrollCollect(fp, {
    read: async () => {
      const out: FeedPost[] = [];
      for (const raw of await fp.page.evaluate<RawPost[]>(READ_POSTS)) {
        if (!raw.text.trim()) continue;
        const post = postOf(raw, now);
        if (post) out.push(post);
        else dropped.add(raw.text.trim().slice(0, 300));
      }
      return out;
    },
    key: (p) => p.urn,
    max,
  });
  return { posts: rows, dropped: dropped.size };
}

export const linkedinSearchPosts = defineFlow<SearchPostsInput, Posts>({
  site: "linkedin",
  name: "search-posts",
  run: (fp, input) => readPosts(fp, postsSearchUrl(input.keywords, input.since), input.max ?? 20),
});

export const linkedinCompanyPosts = defineFlow<CompanyPostsInput, Posts>({
  site: "linkedin",
  name: "company-posts",
  run: (fp, input) => readPosts(fp, companyPostsUrl(input.company), input.max ?? 20, sortRecent),
});
