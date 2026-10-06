/**
 * A member's recent activity (`/in/<vanity>/recent-activity/all/`): their
 * posts, reposts and comments, newest first. Read only: it opens the page
 * and scrolls; it never clicks a post, a reaction, follow or connect. Items
 * that are only a reaction ("likes this") are left out.
 *
 * Written from LinkedIn's feed card layout, not yet mapped in explore: each
 * item is the outermost element under `main` whose `data-urn` is an
 * `urn:li:activity:`. Its text reads a header when it is not their own post
 * ("<name> reposted this", "<name> commented on this"), the author, the age
 * ("2w •", "3mo • Edited •"), the body, then the counts ("52", "12
 * comments"). A comment item's urn is the comment's (`commentUrn=` in its
 * links) when the card links one, so a repost and a comment on one post stay
 * two items. Unproven until a first read as linkedin@alt.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { scrollCollect } from "../scroll-collect.js";
import { ageAt } from "./linkedin-notifications.js";
import { go } from "./linkedin-reach.js";

interface El {
  innerText: string;
  href: string;
  parentElement: El | null;
  closest(sel: string): El | null;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;

const WEB = "https://www.linkedin.com";
const CARD = "main [data-urn^='urn:li:activity:']";
const BODY = ".update-components-text, .feed-shared-update-v2__description";
const COMMENT =
  ".comments-highlighted-comment-item-content-body, .comments-comment-item__main-content, .comments-comment-item-content-body";
const RENDER_MS = 15_000;
const EMPTY = /hasn.t (posted|shared|commented)|no recent activity|nothing to see for now/i;

/** A card as the page holds it: its urn, every word and link, and the body text when found. */
export interface RawActivity {
  urn: string;
  text: string;
  links: string[];
  body?: string;
  comment?: string;
}

export type ActivityKind = "post" | "comment" | "repost";

export interface Activity {
  /** `urn:li:activity:…`, or the comment's `urn:li:comment:(…)` for a comment. */
  urn: string;
  kind: ActivityKind;
  /** Their words: the post, the repost's own text or the reposted one, the comment. */
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
  /\b(reposted|commented on|replied to|likes?|liked|loves|celebrates|supports|finds|reacted to)\b.*\b(this|post|comment)\b/i;
const AGE_LINE = /^(\d+(?:mo|min|yr|hr|s|m|h|d|w|y))\s*(?:•|$)/;
const COUNT = (re: RegExp, text: string) => Number(re.exec(text)?.[1]?.replace(/,/g, "") ?? 0);

function kindOf(header: string | undefined): ActivityKind | null {
  if (!header) return "post";
  if (/\breposted\b/i.test(header)) return "repost";
  if (/\b(commented on|replied to)\b/i.test(header)) return "comment";
  return null;
}

/** One card as an item; null for a reaction, or a card with no urn or no text. */
export function activityOf(raw: RawActivity, now: Date): Activity | null {
  const lines = raw.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const header = lines.slice(0, 3).find((l) => HEADER.test(l));
  const kind = kindOf(header);
  if (!kind || !raw.urn) return null;
  const age = lines.map((l) => AGE_LINE.exec(l)?.[1]).find(Boolean);
  const at = age ? ageAt(age, now) : null;
  // ponytail: with no body element, the longest line stands in; map the page if it reads wrong.
  const longest = lines.filter((l) => l !== header).sort((a, b) => b.length - a.length)[0];
  const text = ((kind === "comment" ? raw.comment : undefined) ?? raw.body ?? longest)?.trim();
  if (!text) return null;
  const commentUrn =
    kind === "comment"
      ? raw.links
          .map((l) => /commentUrn=([^&#]+)/.exec(l)?.[1])
          .find(Boolean)
          ?.replace(/%[0-9A-F]{2}/gi, (m) => decodeURIComponent(m))
      : undefined;
  const plusOthers = /\band ([\d,]+) others?\b/i.exec(raw.text)?.[1];
  const reactions =
    COUNT(/([\d,]+)\s+reactions?\b/i, raw.text) ||
    (plusOthers ? Number(plusOthers.replace(/,/g, "")) + 1 : 0) ||
    Number(lines.find((l) => /^[\d,]+$/.test(l))?.replace(/,/g, "") ?? 0);
  return {
    urn: commentUrn ?? raw.urn,
    kind,
    text,
    ...(age ? { age } : {}),
    ...(at ? { at, approx: true as const } : {}),
    reactions,
    comments: COUNT(/([\d,]+)\s+comments?\b/i, raw.text),
    url: `${WEB}/feed/update/${raw.urn}/`,
    raw,
  };
}

const cardsOnPage = (fp: FlowPage): Promise<RawActivity[]> =>
  fp.page.evaluate(
    ({ card, body, comment }) =>
      [...document.querySelectorAll(card)]
        // A reposted post nested in the card is the card's, not an item of its own.
        .filter((el) => !el.parentElement?.closest(card))
        .map((el) => {
          const b = el.querySelector(body)?.innerText.trim();
          const c = el.querySelector(comment)?.innerText.trim();
          return {
            urn: el.getAttribute("data-urn") ?? "",
            text: el.innerText,
            links: [...el.querySelectorAll("a[href]")].map((a) => a.href),
            ...(b ? { body: b } : {}),
            ...(c ? { comment: c } : {}),
          };
        }),
    { card: CARD, body: BODY, comment: COMMENT },
  );

export interface ActivityInput {
  vanity: string;
  /** How many from the top, newest first (default 20). */
  max?: number;
}

export const linkedinActivity = defineFlow<ActivityInput, { activity: Activity[] }>({
  site: "linkedin",
  name: "activity",
  async run(fp, input) {
    await go(fp, `${WEB}/in/${encodeURIComponent(input.vanity)}/recent-activity/all/`);
    if (!(await fp.has({ css: CARD }, RENDER_MS))) {
      if (EMPTY.test(await fp.text())) return { activity: [] };
      return fp.human(`no activity list at ${fp.url()}`);
    }
    const now = new Date();
    const { rows } = await scrollCollect(fp, {
      read: async () =>
        (await cardsOnPage(fp))
          .map((r) => activityOf(r, now))
          .filter((a): a is Activity => a !== null),
      key: (a) => a.urn,
      max: input.max ?? 20,
    });
    return { activity: rows };
  },
});
