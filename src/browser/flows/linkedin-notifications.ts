/**
 * The signed-in account's notifications page, newest first. Read only:
 * opening the page is the one thing it does (LinkedIn zeroes the badge
 * then), and it scrolls; it never clicks.
 *
 * Mapped 2026-10-06 in explore as linkedin@wren. The page is LinkedIn's
 * server-driven UI with hashed classes: each card is a child of
 * `main [data-testid=lazy-column]`. A card's first link is the actor's
 * avatar (`/in/`, `/company/`, `/showcase/`), the next the thing it is
 * about; the bold runs name the actor; the text is the headline, maybe a
 * second line (their headline, "Powered by Premium"), then the age ("2h",
 * "1w"). Cards carry no urn, so the id hashes the link and the headline.
 * Scrolling loads about ten more per screen.
 */
import { createHash } from "node:crypto";
import { defineFlow, type FlowPage } from "../flow.js";
import { scrollCollect } from "../scroll-collect.js";
import { go } from "./linkedin-reach.js";

interface El {
  innerText: string;
  href: string;
  children: Iterable<El>;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}
declare const document: El;

const WEB = "https://www.linkedin.com";
const LIST = "main [data-testid=lazy-column]";
const RENDER_MS = 15_000;

/** A card as the page holds it: every word and every link, whole. */
export interface RawNotification {
  text: string;
  links: string[];
  /** The bold runs: the actor's name first. */
  bold: string[];
  /** A `data-urn` when the card has one (the older UI did). */
  urn?: string;
}

export type NotificationKind =
  | "follow"
  | "reaction"
  | "comment"
  | "mention"
  | "connection"
  | "view"
  | "other";

export interface Notification {
  id: string;
  kind: NotificationKind;
  actor?: string;
  actorUrl?: string;
  /** The headline, one line, LinkedIn's words. */
  text: string;
  url?: string;
  /** From the age label, so to the unit it shows. */
  at?: string;
  approx?: true;
  raw: RawNotification;
}

/** First match wins: a mention in a comment is a mention, a reaction to a comment a reaction. */
const KINDS: Array<[NotificationKind, RegExp]> = [
  ["mention", /\b(mentioned|tagged) you\b/i],
  [
    "reaction",
    /\b(reacted|likes|liked|loves|celebrated|celebrates|supports|finds|found)\b[^.]*\byour\b/i,
  ],
  ["comment", /\b(commented on|replied to)\b/i],
  ["follow", /\b(followed you|following you|follows you|new followers?)\b/i],
  [
    "connection",
    /\b(accepted your invitation|is now a connection|invitation to connect|wants to connect)\b/i,
  ],
  ["view", /\bviewed your\b|\bprofile views?\b|\bappeared in \d+ search/i],
];

const AGE = /^(just now|now|(\d+)\s*(s|m|min|h|hr|d|w|mo|y|yr)s?)$/i;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
  yr: 365 * 86_400_000,
};

/** "2h" read at `now` as an instant; null for anything that is not an age. */
export function ageAt(label: string, now: Date): string | null {
  const m = AGE.exec(label.trim());
  if (!m) return null;
  const ms = m[2] ? Number(m[2]) * (UNIT_MS[(m[3] ?? "").toLowerCase()] ?? 0) : 0;
  return new Date(now.getTime() - ms).toISOString();
}

const ACTOR_PAGE = /^https:\/\/www\.linkedin\.com\/(in|company|showcase|school)\//;
const bare = (url: string) => url.split(/[?#]/)[0] ?? url;

export function notificationOf(raw: RawNotification, now: Date): Notification | null {
  const lines = raw.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const age = lines.findLast((l) => AGE.test(l));
  const text = lines.find((l) => l !== age);
  if (!text) return null;
  const [first, ...rest] = raw.links;
  const actorUrl = first && ACTOR_PAGE.test(first) ? bare(first) : undefined;
  // "Say congrats" opens a message box: the card is about the next link.
  const url = rest.find((l) => !l.includes("/messaging/")) ?? first;
  const name = raw.bold[0]?.trim();
  const actor = name && !name.endsWith(":") && text.includes(name) ? name : undefined;
  const at = age ? ageAt(age, now) : null;
  const id =
    raw.urn ??
    `h${createHash("sha1")
      .update(`${url ?? ""}\n${text}`)
      .digest("hex")
      .slice(0, 16)}`;
  return {
    id,
    kind: KINDS.find(([, re]) => re.test(text))?.[0] ?? "other",
    ...(actor ? { actor } : {}),
    ...(actorUrl ? { actorUrl } : {}),
    text,
    ...(url ? { url } : {}),
    ...(at ? { at, approx: true as const } : {}),
    raw,
  };
}

const cardsOnPage = (fp: FlowPage): Promise<RawNotification[]> =>
  fp.page.evaluate((list) => {
    const column = document.querySelector(list);
    return [...(column?.children ?? [])]
      .map((card) => {
        const urn =
          card.getAttribute("data-urn") ??
          card.querySelector("[data-urn]")?.getAttribute("data-urn");
        return {
          text: card.innerText,
          links: [...card.querySelectorAll("a[href]")].map((a) => a.href),
          bold: [
            ...new Set([...card.querySelectorAll("strong, b")].map((b) => b.innerText.trim())),
          ],
          ...(urn ? { urn } : {}),
        };
      })
      .filter((c) => c.text.trim());
  }, LIST);

export interface NotificationsInput {
  /** How many from the top, newest first (default 40). */
  max?: number;
}

export const linkedinNotifications = defineFlow<
  NotificationsInput,
  { notifications: Notification[] }
>({
  site: "linkedin",
  name: "notifications",
  async run(fp, input) {
    await go(fp, `${WEB}/notifications/`);
    if (!(await fp.has({ css: LIST }, RENDER_MS)))
      return fp.human(`no notifications list at ${fp.url()}`);
    const now = new Date();
    const { rows } = await scrollCollect(fp, {
      read: async () =>
        (await cardsOnPage(fp))
          .map((r) => notificationOf(r, now))
          .filter((n): n is Notification => n !== null),
      key: (n) => n.id,
      max: input.max ?? 40,
    });
    return { notifications: rows };
  },
});
