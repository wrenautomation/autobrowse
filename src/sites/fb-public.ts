/**
 * Facebook's public pages, read signed out: never Wren's Meta login (it runs our ads, and
 * Meta bans accounts that scrape). Each route is a built walk on the owner's Mac
 * (`walks/fb-public/<name>.json`, a `records` op, designs/2026-10-05-records-and-ai-steps.md),
 * so call it on the desk. `GET /ads?q=` is the Ad Library: ads running now for a keyword,
 * with the advertiser's page and the link each ad sends to. The Ad Library API only covers
 * political ads outside the EU, so this is the browser read. Groups: Meta removed the Groups API
 * in 2024. Signed out, a group's About reads whole and its feed shows only the featured post, but
 * a single post's page reads whole with its top comments, and Google indexes public posts: so
 * `GET /groups?q=` finds groups and posts through Google, then the About and post walks read them.
 */
import { z } from "zod";
import type { Serp } from "../browser/flows/google-search.js";
import type { WalkOutput } from "../walks/flow.js";
import { route, type SiteApi } from "./types.js";

const GROUP_URL =
  /^https:\/\/(?:www\.|m\.)?facebook\.com\/groups\/([\w.-]+)\/?(?:(?:posts|permalink)\/(\d+))?/;
const id = z.string().regex(/^[\w.-]{2,100}$/);

export interface GroupHit {
  group: string;
  /** As Google names the site: "Facebook · <group>". */
  name: string | null;
  url: string;
  posts: {
    post: string;
    url: string;
    title: string;
    snippet: string | null;
    shown: string | null;
  }[];
}

/** Google's results grouped by Facebook group, each with the public posts Google showed. */
export function groupsOf(serp: Serp): GroupHit[] {
  const by = new Map<string, GroupHit>();
  for (const r of serp.results) {
    const m = r.url?.match(GROUP_URL);
    if (!m || !r.url) continue;
    const group = m[1] as string;
    const hit = by.get(group) ?? {
      group,
      name: null,
      url: `https://www.facebook.com/groups/${group}/`,
      posts: [],
    };
    hit.name ??= r.site?.replace(/^Facebook\s*·\s*/, "").trim() || null;
    if (m[2])
      hit.posts.push({
        post: m[2],
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        shown: r.date ?? r.shown,
      });
    by.set(group, hit);
  }
  return [...by.values()];
}

const rowsOf = (o: unknown, as: string) => (o as WalkOutput).records[as] ?? [];

export const fbPublic: SiteApi = {
  site: "fb-public",
  origin: "https://www.facebook.com",
  auth: { open: true },
  signedOut: true,
  // About 30 ads a read; a person browsing the library doesn't load hundreds of pages a day.
  caps: { reads: 200, google: 100 },
  pace: { gapMs: 20_000, jitterMs: 20_000 },
  routes: [
    route({
      method: "GET",
      path: "/ads",
      summary:
        "Ads running now for keyword `q` in `country` (default US), newest layout first: Library ID, advertiser, its page, start date, text, call to action, the link it sends to (`url`, every one in `urls`), the shown domain (`caption`), and the card's whole text (`all`). A browser leg: call it on the desk",
      request: z.object({
        q: z.string().trim().min(2).max(100),
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .default("US"),
      }),
      meter: () => ({ reads: 1 }),
      browser: {
        flow: "fb-public/walk-ad-library",
        output: (o) => ({ ads: (o as WalkOutput).records.ads ?? [] }),
      },
    }),
    route({
      method: "GET",
      path: "/groups",
      summary:
        "Facebook groups about `q` through Google (`site:facebook.com/groups`, `n` results, default 10, up to 30): each group's id, name and link, with the public posts Google showed (link, title, snippet); `serp` is Google's whole page. A browser leg: call it on the desk",
      request: z.object({
        q: z.string().trim().min(2).max(200),
        n: z.coerce.number().int().min(1).max(30).default(10),
      }),
      meter: ({ n }) => ({ google: Math.ceil(n / 10) }),
      browser: {
        flow: "web/google",
        input: ({ q, n }) => ({ q: `site:facebook.com/groups ${q}`, n }),
        output: (o) => ({ groups: groupsOf(o as Serp), serp: o }),
      },
    }),
    route({
      method: "GET",
      path: "/groups/{group}",
      summary:
        "A group's About as a visitor sees it: name, privacy, members, the About text (cut where Facebook cuts it), place, created date, posts today and last month, total members, admins, and the panel's whole text (`all`). A private group shows this too. A browser leg: call it on the desk",
      request: z.object({ group: id }),
      meter: () => ({ reads: 1 }),
      browser: {
        flow: "fb-public/walk-group-about",
        output: (o) => ({ about: rowsOf(o, "about")[0] ?? null }),
      },
    }),
    route({
      method: "GET",
      path: "/groups/{group}/posts/{post}",
      summary:
        "One public group post as a visitor sees it: author (no profile link signed out), badge, time, Meta's AI title, text, reaction, comment and share counts, links out, the whole text (`all`); and the top comments shown (author, text, age, reactions). A browser leg: call it on the desk",
      request: z.object({ group: id, post: z.string().regex(/^\d{5,25}$/) }),
      meter: () => ({ reads: 1 }),
      browser: {
        flow: "fb-public/walk-group-post",
        output: (o) => ({ post: rowsOf(o, "post")[0] ?? null, comments: rowsOf(o, "comments") }),
      },
    }),
  ],
  setup: [],
};
