/**
 * A video's numbers off its YouTube Studio analytics page, read from the
 * page's own `yta_web/get_cards` answers. Never replayed: Studio runs bot
 * checks on its calls. The one number the Analytics API lacks is a Short's
 * "viewed vs swiped away" (`shortsFeedImpressionsVtr`, the percent that
 * stayed to watch). Mapped 2026-10-23 in explore as google@wren on
 * /video/<id>/analytics/tab-overview/period-default. Read only: it opens one
 * page and never clicks.
 */
import type { Response } from "playwright";
import { defineFlow } from "../flow.js";

export interface StudioAnalyticsInput {
  videoId: string;
}

export interface StudioTotals {
  /** Percent of feed plays that stayed to watch (Shorts only); null when the page has none. */
  viewedPct: number | null;
  avgViewSecs: number | null;
  /** Percent of the video watched, on average (0..100). */
  avgViewPct: number | null;
  views: number | null;
}

export interface StudioAnalytics extends StudioTotals {
  videoId: string;
  url: string;
}

const CARDS = "/youtubei/v1/yta_web/get_cards";
const FIRST_MS = 30_000;
const POLL_MS = 1_000;
/** After the first answer, how long later cards may still come. */
const SETTLE_MS = 3_000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Every `metricTotals` object in the answers, depth first. */
function totalsIn(body: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(body)) {
    for (const v of body) totalsIn(v, out);
    return;
  }
  if (!body || typeof body !== "object") return;
  for (const [k, v] of Object.entries(body)) {
    if (k === "metricTotals" && v && typeof v === "object") out.push(v as Record<string, unknown>);
    else totalsIn(v, out);
  }
}

/** The totals the cards carry; the first card that has a number wins. */
export function studioTotalsOf(bodies: readonly unknown[]): StudioTotals {
  const found: Record<string, unknown>[] = [];
  for (const b of bodies) totalsIn(b, found);
  const first = (key: string) => {
    for (const t of found) {
      const v = num(t[key]);
      if (v !== null) return v;
    }
    return null;
  };
  const ms = first("avgViewDurationMillis");
  const pct = first("avgPercentageWatched");
  return {
    viewedPct: first("shortsFeedImpressionsVtr"),
    avgViewSecs: ms === null ? null : ms / 1000,
    avgViewPct: pct === null ? null : Math.round(pct * 10_000) / 100,
    views: first("views"),
  };
}

export const youtubeStudioAnalytics = defineFlow<StudioAnalyticsInput, StudioAnalytics>({
  site: "google",
  name: "youtube-studio-analytics",
  async run(fp, { videoId }) {
    if (!/^[\w-]{6,20}$/.test(videoId)) return fp.human(`${videoId} is not a YouTube video id`);
    const bodies: unknown[] = [];
    const pending: Array<Promise<void>> = [];
    const onResponse = (r: Response) => {
      if (!r.url().includes(CARDS)) return;
      pending.push(
        r.json().then(
          (body: unknown) => {
            bodies.push(body);
          },
          () => undefined,
        ),
      );
    };
    fp.page.on("response", onResponse);
    try {
      await fp.open(
        `https://studio.youtube.com/video/${encodeURIComponent(videoId)}/analytics/tab-overview/period-default`,
      );
      for (let waited = 0; !bodies.length && waited < FIRST_MS; waited += POLL_MS) {
        await fp.wait(POLL_MS);
        await Promise.all(pending);
      }
      if (!bodies.length)
        return fp.human(
          `${fp.url()} made no analytics call: the profile may not own ${videoId}, or Studio changed`,
        );
      await fp.wait(SETTLE_MS);
      await Promise.all(pending);
    } finally {
      fp.page.off("response", onResponse);
    }
    return { videoId, url: fp.url(), ...studioTotalsOf(bodies) };
  },
});
