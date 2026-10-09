/**
 * One post's analytics page, read as the signed-in account (Wren's own, the
 * author). LinkedIn's Community Management API would answer this; until it is
 * approved, wren reads the page. Read only: it opens pages and never clicks.
 *
 * At most three page loads: `/analytics/post-summary/<urn>/`; when that shows
 * no analytics (it may not take a share or ugcPost urn), the post itself at
 * `/feed/update/<urn>/`, whose "View analytics" link names the urn the
 * analytics page takes; then that link.
 *
 * Counts are read off the visible text. A count sits on its own line, before
 * its label ("1,204" then "Impressions") or after it ("Reactions" then "12"),
 * or on the label's line ("Reposts 3"). Unproven live: no live read was made.
 */
import { defineFlow, type FlowPage } from "../flow.js";
import { go } from "./linkedin-reach.js";

const WEB = "https://www.linkedin.com";
const RENDER_MS = 15_000;
const SETTLE_MS = 1_500;
const SETTLE_TRIES = 4;
const RAW_CAP = 4_000;

export const POST_URN = /^urn:li:(activity|share|ugcPost):[0-9]+$/;

export interface PostStats {
  impressions: number | null;
  reached: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  saves: number | null;
  sends: number | null;
  profileViewers: number | null;
  followersGained: number | null;
}

export interface PostAnalytics extends PostStats {
  urn: string;
  /** The analytics page read. */
  url: string;
  /** The page text, capped. */
  raw: string;
}

/** Each count's labels as the page writes them; the longer one first. */
const LABELS: Record<keyof PostStats, string[]> = {
  impressions: ["impressions"],
  reached: ["members reached"],
  reactions: ["reactions"],
  comments: ["comments"],
  reposts: ["reposts"],
  saves: ["saves"],
  sends: ["sends on linkedin", "sends"],
  profileViewers: ["profile viewers from this post"],
  followersGained: ["followers gained from this post"],
};
const KEYS = Object.keys(LABELS) as Array<keyof PostStats>;
const NUM = "(\\d[\\d,.]*)\\s*([KkMm])?";
const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000 };

/** "1,204" is 1204, "1.2K" is 1200; anything else is null. */
export function countIn(s: string): number | null {
  const m = new RegExp(`^${NUM}$`).exec(s.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, "")) * (SUFFIX[(m[2] ?? "").toLowerCase()] ?? 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

const labelOf = (line: string): keyof PostStats | null => {
  const l = line.toLowerCase().replace(/:$/, "").trim();
  return KEYS.find((k) => LABELS[k].includes(l)) ?? null;
};

/** "Reposts 3", "Reposts: 3", "3 Reposts": a count on its label's line. */
function sameLine(line: string): [keyof PostStats, number] | null {
  for (const k of KEYS)
    for (const label of LABELS[k]) {
      const m =
        new RegExp(`^${label}:?\\s+(.+)$`, "i").exec(line) ??
        new RegExp(`^(.+?)\\s+${label}$`, "i").exec(line);
      const n = m?.[1] ? countIn(m[1]) : null;
      if (n !== null) return [k, n];
    }
  return null;
}

/**
 * The counts on an analytics page's text; a missing label is null. Lines that
 * alternate count and label form a run; a run that opens on a count pairs each
 * count with the label after it, one that opens on a label pairs it with the
 * count after it. Any other line ends the run. The first value found wins.
 */
export function postAnalyticsOf(text: string): PostStats {
  const out = Object.fromEntries(KEYS.map((k) => [k, null])) as unknown as Record<
    keyof PostStats,
    number | null
  >;
  const put = (k: keyof PostStats, n: number) => {
    if (out[k] === null) out[k] = n;
  };
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  type Tok = { label: keyof PostStats } | { n: number } | null;
  const toks: Tok[] = lines.map((l) => {
    const label = labelOf(l);
    if (label) return { label };
    const n = countIn(l);
    return n === null ? null : { n };
  });
  let i = 0;
  while (i < toks.length) {
    const first = toks[i];
    if (!first) {
      i++;
      continue;
    }
    // The run: tokens that alternate count and label.
    let end = i + 1;
    while (end < toks.length) {
      const prev = toks[end - 1];
      const cur = toks[end];
      if (!cur || !prev) break;
      const alternates = "n" in cur !== "n" in prev;
      if (!alternates) break;
      end++;
    }
    for (let j = i; j + 1 < end; j += 2) {
      const a = toks[j];
      const b = toks[j + 1];
      if (a && b && "n" in a && "label" in b) put(b.label, a.n);
      if (a && b && "label" in a && "n" in b) put(a.label, b.n);
    }
    i = end;
  }
  for (const l of lines) {
    const hit = sameLine(l);
    if (hit) put(...hit);
  }
  return out;
}

const hasAnalytics = (s: PostStats) => s.impressions !== null || s.reached !== null;

/** The page's counts once it shows some, or null when it never does. */
async function readStats(fp: FlowPage): Promise<{ stats: PostStats; text: string } | null> {
  if (!(await fp.has({ css: "main" }, RENDER_MS))) return null;
  for (let i = 0; i < SETTLE_TRIES; i++) {
    const text = await fp.text();
    const stats = postAnalyticsOf(text);
    if (hasAnalytics(stats)) return { stats, text };
    await fp.wait(SETTLE_MS);
  }
  return null;
}

/** The post page's link to its analytics, absolute, or null when it shows none. */
export function analyticsLinkIn(html: string): string | null {
  const m = /href="([^"]*\/analytics\/post-summary\/[^"]*)"/.exec(html);
  if (!m?.[1]) return null;
  return new URL(m[1].replace(/&amp;/g, "&"), WEB).toString();
}

export interface PostAnalyticsInput {
  urn: string;
}

export const linkedinPostAnalytics = defineFlow<PostAnalyticsInput, PostAnalytics>({
  site: "linkedin",
  name: "post-analytics",
  async run(fp, { urn }) {
    if (!POST_URN.test(urn)) return fp.human(`${urn} is not a post urn`);
    const done = (r: { stats: PostStats; text: string }): PostAnalytics => ({
      urn,
      url: fp.url(),
      ...r.stats,
      raw: r.text.slice(0, RAW_CAP),
    });
    await go(fp, `${WEB}/analytics/post-summary/${urn}/`);
    const direct = await readStats(fp);
    if (direct) return done(direct);
    await go(fp, `${WEB}/feed/update/${urn}/`);
    if (!(await fp.has({ css: "main" }, RENDER_MS))) return fp.human(`no post at ${fp.url()}`);
    const link = analyticsLinkIn(await fp.html());
    if (!link)
      return fp.human(
        `the post at ${fp.url()} has no analytics link: this account may not be its author`,
      );
    await go(fp, link);
    const linked = await readStats(fp);
    if (linked) return done(linked);
    return fp.human(
      `${fp.url()} is not an analytics page: it shows neither impressions nor members reached`,
    );
  },
});
