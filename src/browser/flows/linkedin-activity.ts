/**
 * A member's recent activity: their posts, reposts and comments, newest
 * first. Read only: it opens two tabs and scrolls; it never clicks a post, a
 * reaction, follow or connect. Reaction-only items ("likes this") are left out.
 *
 * Mapped 2026-10-06 in explore on LinkedIn's SDUI layout (no `data-urn`,
 * obfuscated classes). Two tabs: `/recent-activity/all/` holds posts and
 * reposts, `/recent-activity/comments/` the comments ("All activity" can be
 * "Nothing to see for now" for a member who only comments). Each item is a
 * `[componentkey^="update-card-focus"]` list item (an `h2` "Feed post"
 * inside); the rest of its componentkey is an opaque hash, stable across
 * loads. Its text reads "Feed post", a header when it is not their own post
 * ("<name> reposted this", "<name> commented"), the author, the age ("2w •"),
 * the body (`[data-testid="expandable-text-box"]`), then the action buttons,
 * whose labels ("Reaction button state: …", "Comment", "Repost") hold the
 * counts. A comment is a `[componentkey^="replaceableComment_urn:li:comment:(activity:…,…)"]`
 * block; theirs is the one whose first profile link is the member's, with
 * its own age line ("9mo"), text box and buttons.
 *
 * Post cards carry no urn. A repost often links the reposted post
 * (`/feed/update/urn:li:activity:…`); that is its urn. A post's only link
 * may be a quoted post's, so a post (and a repost with no link) is keyed by
 * the card hash: `urn:li:card:<hash>`, url the member's activity page.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { scrollCollect } from "../scroll-collect.js";
import { ageAt } from "./linkedin-notifications.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";
const CARD = "main [componentkey^='update-card-focus']";
const RENDER_MS = 15_000;
const EMPTY = /hasn.t (posted|shared|commented)|no recent activity|nothing to see for now/i;

/** Their comment block in a comments-tab card. */
export interface RawComment {
  urn: string;
  /** Its own age line ("9mo"). */
  age?: string;
  text: string;
  reactions: number;
  replies: number;
}

/** A card as the page holds it: its hash, every word and link, the body and counts. */
export interface RawActivity {
  /** The card's componentkey hash, stable across loads. */
  key: string;
  text: string;
  links: string[];
  body?: string;
  reactions: number;
  comments: number;
  comment?: RawComment;
}

export type ActivityKind = "post" | "comment" | "repost";

export interface Activity {
  /** `urn:li:activity:…` (or `urn:li:card:<hash>` when the card names none), the comment's `urn:li:comment:(…)` for a comment. */
  urn: string;
  kind: ActivityKind;
  /** Their words: the post, the reposted post, the comment. */
  text: string;
  /** The page's age label ("2w"), and the instant it reads as at the read. */
  age?: string;
  at?: string;
  approx?: true;
  reactions: number;
  comments: number;
  url: string;
  raw: RawActivity;
}

const HEADER =
  /\b(reposted|commented|replied|likes?|liked|loves|celebrates|supports|finds|reacted)\b/i;
const AGE_LINE = /^(\d+(?:mo|min|yr|hr|s|m|h|d|w|y))\s*(?:•|$)/;
const FEED_URN = /\/feed\/update\/(urn:li:(?:activity|ugcPost|share):\d+)/;

function kindOf(header: string | undefined): ActivityKind | null {
  if (!header) return "post";
  if (/\breposted\b/i.test(header)) return "repost";
  if (/\b(commented|replied)\b/i.test(header)) return "comment";
  return null;
}

const linesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "Feed post");

/** One card as an item; null for a reaction, or a card with no key or no text. */
export function activityOf(raw: RawActivity, now: Date, vanity: string): Activity | null {
  const lines = linesOf(raw.text);
  const header = lines.slice(0, 2).find((l) => HEADER.test(l));
  const kind = kindOf(header);
  if (!kind || !raw.key) return null;
  // A comment card with no comment of theirs (it lazy-loads, or it is a reply we cannot see) is no item.
  if (kind === "comment" && !raw.comment) return null;
  const c = kind === "comment" ? raw.comment : undefined;
  const age = c ? c.age : lines.map((l) => AGE_LINE.exec(l)?.[1]).find(Boolean);
  const at = age ? ageAt(age, now) : null;
  const text = (c ? c.text : raw.body)?.trim();
  if (!text) return null;
  const linked = raw.links.map((l) => FEED_URN.exec(l)?.[1]).find(Boolean);
  const urn = c?.urn ?? (kind === "repost" && linked ? linked : `urn:li:card:${raw.key}`);
  const postUrn = c ? /activity:(\d+)/.exec(c.urn)?.[1] : undefined;
  const url = postUrn
    ? `${WEB}/feed/update/urn:li:activity:${postUrn}/`
    : urn.startsWith("urn:li:card:")
      ? `${WEB}/in/${encodeURIComponent(vanity)}/recent-activity/all/`
      : `${WEB}/feed/update/${urn}/`;
  return {
    urn,
    kind,
    text,
    ...(age ? { age } : {}),
    ...(at ? { at, approx: true as const } : {}),
    reactions: c ? c.reactions : raw.reactions,
    comments: c ? c.replies : raw.comments,
    url,
    raw,
  };
}

/**
 * The page script: every card on screen as a RawActivity. A string, not a
 * function: tsx wraps named helpers in `__name`, which the page lacks.
 * `vanity` finds their own comment block.
 */
export const readCards = (vanity: string): string => `(() => {
  const BOX = '[data-testid="expandable-text-box"]';
  const CMT = '[componentkey^="replaceableComment_urn:li:comment:"]';
  const REACT = "button[aria-label^='Reaction button state']";
  const AGE = /^\\s*(\\d+(?:mo|min|yr|hr|s|m|h|d|w|y))\\s*$/;
  const me = ${JSON.stringify(`/in/${vanity.toLowerCase()}/`)};
  const num = (el) => {
    const m = /([\\d.,]+)\\s*([KM])?/i.exec(el ? el.innerText : "");
    return m ? Math.round(Number(m[1].replace(/,/g, "")) * ({ k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()] || 1)) : 0;
  };
  const first = (root, sel, inside) => [...root.querySelectorAll(sel)].find((e) => e.closest(CMT) === inside) || null;
  return [...document.querySelectorAll(${JSON.stringify(CARD)})].map((card) => {
    const key = (card.getAttribute("componentkey") || "").replace(/^update-card-focus/, "").replace(/FeedType_\\w+$/, "");
    const body = first(card, BOX, null)?.innerText.trim();
    const block = [...card.querySelectorAll(CMT)].find((k) => {
      const author = first(k, "a[href*='/in/']", k);
      return decodeURIComponent(author ? author.href : "").toLowerCase().includes(me);
    });
    const age = block && block.innerText.split("\\n").map((l) => AGE.exec(l)?.[1]).find(Boolean);
    const comment = block && {
      urn: (block.getAttribute("componentkey") || "").replace(/^replaceableComment_/, ""),
      ...(age ? { age } : {}),
      text: first(block, BOX, block)?.innerText.trim() || "",
      // A comment's counts are words ("2 reactions", "3 replies"), not button numbers.
      reactions: Number((/([\\d,]+) reactions?\\b/i.exec(block.innerText) || [])[1]?.replace(/,/g, "") || 0),
      replies: Number((/([\\d,]+) repl(?:y|ies)\\b/i.exec(block.innerText) || [])[1]?.replace(/,/g, "") || 0),
    };
    return {
      key,
      text: card.innerText,
      links: [...card.querySelectorAll("a[href]")].map((l) => l.href),
      ...(body ? { body } : {}),
      reactions: num(first(card, REACT, null)),
      comments: num(first(card, "button[aria-label='Comment']", null)),
      ...(comment ? { comment } : {}),
    };
  });
})()`;

export interface ActivityInput {
  vanity: string;
  /** How many from the top, newest first (default 20). */
  max?: number;
}

/** One tab's items, read by scrolling; [] when the tab says it is empty. */
async function readTab(
  fp: FlowPage,
  tab: string,
  vanity: string,
  max: number,
): Promise<Activity[]> {
  await go(fp, `${WEB}/in/${encodeURIComponent(vanity)}/recent-activity/${tab}/`);
  if (!(await fp.has({ css: CARD }, RENDER_MS))) {
    if (EMPTY.test(await fp.text())) return [];
    return fp.human(`no activity list at ${fp.url()}`);
  }
  const now = new Date();
  const { rows } = await scrollCollect(fp, {
    read: async () =>
      (await fp.page.evaluate<RawActivity[]>(readCards(vanity)))
        .map((r) => activityOf(r, now, vanity))
        // The all tab may show a comment too; the comments tab is where they are read.
        .filter(
          (a): a is Activity => a !== null && (tab === "comments") === (a.kind === "comment"),
        ),
    key: (a) => a.urn,
    max,
  });
  return rows;
}

/** Both tabs, newest first; an item with no age goes last. */
export function newestFirst(lists: Activity[][], max: number): Activity[] {
  const t = (a: Activity) => (a.at ? Date.parse(a.at) : 0);
  return lists
    .flat()
    .sort((a, b) => t(b) - t(a))
    .slice(0, max);
}

export const linkedinActivity = defineFlow<ActivityInput, { activity: Activity[] }>({
  site: "linkedin",
  name: "activity",
  async run(fp, input) {
    const max = input.max ?? 20;
    const posts = await readTab(fp, "all", input.vanity, max);
    const comments = await readTab(fp, "comments", input.vanity, max);
    return { activity: newestFirst([posts, comments], max) };
  },
});
