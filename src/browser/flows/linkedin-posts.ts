/**
 * Recent posts by others, for wren's comment loop: a content search for a
 * keyword, or a company's Posts tab. Read only: it opens one page and
 * scrolls; it never clicks a post, a reaction, follow or connect.
 *
 * A post is only worth reading here with its urn (the comment route needs
 * one), so a card that names none is dropped and counted. The urn comes from,
 * first to last: a `data-urn` or `data-id` on or inside the card, any other
 * attribute naming `urn:li:(activity|ugcPost|share):N` (a componentkey), or a
 * `/feed/update/urn:li:…` link.
 *
 * Two layouts. Classic: `div.feed-shared-update-v2[data-urn]` with
 * `.update-components-actor__*` for the author and `.update-components-text`
 * for the body, social counts under it. SDUI (mapped 2026-10-06 on activity
 * pages, see linkedin-activity.ts): `[componentkey^="update-card-focus"]`
 * cards, `[data-testid="expandable-text-box"]` body, reaction and comment
 * buttons holding the counts. Neither layout is mapped on the search or
 * company pages yet: the selectors are the feed's, unproven there.
 */
import { defineFlow, type FlowPage } from "../flow.js";
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
  /** `https://www.linkedin.com/in/<vanity>/` or `/company/<handle>/`, query stripped. */
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
const AUTHOR_URL = /^https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(in|company)\/([^/?#]+)/i;
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

/** The post's urn from the card's attributes, then its feed links; null when it names none. */
export function urnOf(raw: Pick<RawPost, "ids" | "links">): string | null {
  for (const v of raw.ids) {
    const m = POST_URN.exec(v);
    if (m) return m[0];
  }
  for (const l of raw.links) {
    const m = FEED_URN.exec(decode(l));
    if (m?.[1]) return m[1];
  }
  return null;
}

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
    text: raw.body?.trim() ?? "",
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
  const AUTHOR = /linkedin\\.com\\/(in|company)\\//;
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
 * articles or videos). `sortBy=recent` is a guess: the "Sort by" menu may not
 * read the query, so the order is the page's (a pinned post can lead).
 */
export const companyPostsUrl = (company: string): string => {
  const id = /\/company\/([^/?#]+)/.exec(company)?.[1] ?? company;
  return `${WEB}/company/${encodeURIComponent(decode(id))}/posts/?feedView=all&sortBy=recent`;
};

/** One page's posts, read by scrolling; none when the page says it is empty. */
export async function readPosts(fp: FlowPage, url: string, max: number): Promise<Posts> {
  await go(fp, url);
  if (!(await fp.has({ css: CARD }, RENDER_MS))) {
    if (EMPTY.test(await fp.text())) return { posts: [], dropped: 0 };
    return fp.human(`no post list at ${fp.url()}`);
  }
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
  run: (fp, input) => readPosts(fp, companyPostsUrl(input.company), input.max ?? 20),
});
