/**
 * One video's numbers off its TikTok Studio analytics page, read from the
 * page's own `/aweme/v2/data/insight/` answers. TikTok's Display API gives
 * counts only; the curve, the sources and the viewers live here. Never
 * replayed: the page signs its calls. Read only: it opens one page and never
 * clicks.
 *
 * Mapped 2026-10-23 in explore on /tiktokstudio/analytics/<id>: one load asks
 * for every type below. A field answers `{ status, value }`, some wrapped in a
 * day's `{ value: { status, value } }`. Status 0 is data; 2 is none (TikTok
 * holds most fields until 100 views). A list answers `[{ key, value }]`.
 * Buckets keep TikTok's keys as they come. Unproven live: our videos had 0
 * views, and the recorder hid the keys, so the key names and the retention
 * shape are not seen yet.
 */
import type { Response } from "playwright";
import { defineFlow } from "../flow.js";

const WEB = "https://www.tiktok.com";
const INSIGHT = "/aweme/v2/data/insight/";
const FIRST_MS = 30_000;
const POLL_MS = 1_000;
/** After the first answer, how long later answers may still come. */
const SETTLE_MS = 4_000;

export interface Bucket {
  key: string;
  value: number;
}

export interface TikTokVideoAnalytics {
  videoId: string;
  url: string;
  /** The video's length, from the page's own video_info. */
  durationSecs: number | null;
  views: number | null;
  uniqueViewers: number | null;
  totalPlaySecs: number | null;
  avgWatchSecs: number | null;
  /** Share of views watched to the end, as TikTok gives it. */
  finishRate: number | null;
  newFollowers: number | null;
  /** The curve as TikTok gives it: key = the point in the video, value = share still watching. */
  retention: Bucket[] | null;
  /** Each share as TikTok gives it (0..1). */
  sources: Bucket[] | null;
  searchTerms: Bucket[] | null;
  age: Bucket[] | null;
  gender: Bucket[] | null;
  location: Bucket[] | null;
  followerShare: number | null;
  nonFollowerShare: number | null;
  newViewerShare: number | null;
  returnViewerShare: number | null;
  /** Fields with data (status 0) that no name above takes: new ones to map. */
  other: string[];
}

type Read = number | Bucket[];

/** Each field the flow names, and the answer keys it reads (the first with data wins). */
const FIELDS = {
  views: ["realtime_total_video_views", "vv_history"],
  uniqueViewers: ["unique_viewer_num", "video_uv"],
  totalPlaySecs: ["video_total_duration_realtime"],
  avgWatchSecs: ["video_per_duration_realtime"],
  finishRate: ["video_finish_rate_realtime"],
  newFollowers: ["realtime_new_followers", "video_new_followers"],
  retention: ["video_retention_rate_realtime"],
  sources: ["video_traffic_source_percent_realtime"],
  searchTerms: ["item_search_terms"],
  age: ["video_viewer_age_percent_realtime"],
  gender: ["video_viewer_gender_percent_realtime"],
  location: ["video_viewer_location_percent_realtime"],
  followerShare: ["video_viewer_follower_percent_realtime", "video_viewer_follower_percent"],
  nonFollowerShare: [
    "video_viewer_nonfollower_percent_realtime",
    "video_viewer_non_follower_percent",
  ],
  newViewerShare: ["video_viewer_new_viewer_percent"],
  returnViewerShare: ["video_viewer_return_viewer_percent"],
} as const;
type Field = keyof typeof FIELDS;
const LISTS = new Set<Field>(["retention", "sources", "searchTerms", "age", "gender", "location"]);
/** Answer keys that are not fields: the envelope, the video, and day series. */
const NOT_FIELDS = /^(extra|log_pb|status_code|status_msg|video_info)$|_history/;

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const finite = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** A field's data, or null for none: unwraps the day wrapper, drops any status but 0. */
export function readField(raw: unknown): Read | null {
  let o = rec(raw);
  if (o && !("status" in o) && rec(o.value)) o = rec(o.value);
  if (o?.status !== 0) return null;
  if (Array.isArray(o.value)) {
    const out: Bucket[] = [];
    for (const item of o.value) {
      const b = rec(item);
      const key = b?.key;
      const value = finite(b?.str_value) ?? finite(b?.value);
      if ((typeof key === "string" || typeof key === "number") && value !== null)
        out.push({ key: String(key), value });
    }
    return out;
  }
  return finite(o.value);
}

/** The numbers on the page's answers; later answers fill only what earlier ones left empty. */
export function tiktokAnalyticsOf(
  bodies: readonly unknown[],
): Omit<TikTokVideoAnalytics, "videoId" | "url"> {
  const merged = new Map<string, Read>();
  let durationMs: number | null = null;
  for (const body of bodies) {
    const b = rec(body);
    if (!b) continue;
    durationMs ??= finite(rec(rec(b.video_info)?.video)?.duration);
    for (const [k, v] of Object.entries(b)) {
      if (merged.has(k) || NOT_FIELDS.test(k)) continue;
      const read = readField(v);
      if (read !== null) merged.set(k, read);
    }
  }
  const taken = new Set<string>();
  const pick = (f: Field): Read | null => {
    for (const k of FIELDS[f]) {
      const v = merged.get(k);
      if (v === undefined) continue;
      taken.add(k);
      if (Array.isArray(v) === LISTS.has(f)) return v;
    }
    return null;
  };
  const num = (f: Field) => {
    const v = pick(f);
    return typeof v === "number" ? v : null;
  };
  const list = (f: Field) => {
    const v = pick(f);
    return Array.isArray(v) ? v : null;
  };
  const out = {
    durationSecs: durationMs === null ? null : durationMs / 1000,
    views: num("views"),
    uniqueViewers: num("uniqueViewers"),
    totalPlaySecs: num("totalPlaySecs"),
    avgWatchSecs: num("avgWatchSecs"),
    finishRate: num("finishRate"),
    newFollowers: num("newFollowers"),
    retention: list("retention"),
    sources: list("sources"),
    searchTerms: list("searchTerms"),
    age: list("age"),
    gender: list("gender"),
    location: list("location"),
    followerShare: num("followerShare"),
    nonFollowerShare: num("nonFollowerShare"),
    newViewerShare: num("newViewerShare"),
    returnViewerShare: num("returnViewerShare"),
  };
  return { ...out, other: [...merged.keys()].filter((k) => !taken.has(k)).sort() };
}

export const tiktokVideoAnalytics = defineFlow<{ videoId: string }, TikTokVideoAnalytics>({
  site: "tiktok",
  name: "video-analytics",
  async run(fp, { videoId }) {
    if (!/^\d+$/.test(videoId)) return fp.human(`${videoId} is not a TikTok video id`);
    const bodies: unknown[] = [];
    const pending: Array<Promise<void>> = [];
    const onResponse = (r: Response) => {
      if (!r.url().includes(INSIGHT)) return;
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
      await fp.open(`${WEB}/tiktokstudio/analytics/${videoId}`);
      for (let waited = 0; !bodies.length && waited < FIRST_MS; waited += POLL_MS) {
        await fp.wait(POLL_MS);
        await Promise.all(pending);
      }
      if (!bodies.length)
        return fp.human(
          `${fp.url()} made no insight call: the profile may be signed out, may not own ${videoId}, or Studio changed`,
        );
      await fp.wait(SETTLE_MS);
      await Promise.all(pending);
    } finally {
      fp.page.off("response", onResponse);
    }
    return { videoId, url: fp.url(), ...tiktokAnalyticsOf(bodies) };
  },
});
