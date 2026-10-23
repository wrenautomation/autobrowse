import { describe, expect, it } from "vitest";
import { readField, tiktokAnalyticsOf } from "./tiktok-video-analytics.js";

const day = (value: unknown, status = 0) => ({
  is_after_7d: false,
  value: { status, value },
  value_compare_previous_day: { status: 0, value: 0 },
});

describe("tiktok studio insight", () => {
  it("reads a field's data and drops any status but 0", () => {
    expect(readField({ status: 0, value: 12 })).toBe(12);
    expect(readField(day(3.5))).toBe(3.5);
    expect(readField({ status: 2, value: null })).toBeNull();
    expect(readField(day(null, 2))).toBeNull();
    expect(readField({ is_after_7d: false })).toBeNull();
    expect(readField(day([{ key: "18-24", str_value: "0.60", value: 0.6 }, { key: 25 }]))).toEqual([
      { key: "18-24", value: 0.6 },
    ]);
  });

  it("merges the answers into named numbers and keeps unmapped fields", () => {
    const first = {
      status_code: 0,
      extra: { now: 1 },
      video_info: { aweme_id: "1", video: { duration: 37_700 } },
      realtime_total_video_views: day(240),
      realtime_finish_rate_history: { status: 0, list: [] },
      video_per_duration_realtime: day(6.2),
      video_finish_rate_realtime: day(0.11),
      video_traffic_source_percent_realtime: day([
        { key: "For You", str_value: "0.90", value: 0.9 },
        { key: "Search", str_value: "0.10", value: 0.1 },
      ]),
      video_viewer_follower_percent_realtime: { is_after_7d: false, value: { status: 2 } },
      item_search_terms: { status: 2, value: null },
      brand_new_field: { status: 0, value: 4 },
    };
    const later = {
      realtime_total_video_views: day(999),
      video_viewer_follower_percent: { status: 0, value: 0.2 },
      video_retention_rate_realtime: day([
        { key: "0", value: 1 },
        { key: "3", value: 0.55 },
      ]),
    };
    expect(tiktokAnalyticsOf([first, later])).toEqual({
      durationSecs: 37.7,
      views: 240,
      uniqueViewers: null,
      totalPlaySecs: null,
      avgWatchSecs: 6.2,
      finishRate: 0.11,
      newFollowers: null,
      retention: [
        { key: "0", value: 1 },
        { key: "3", value: 0.55 },
      ],
      sources: [
        { key: "For You", value: 0.9 },
        { key: "Search", value: 0.1 },
      ],
      searchTerms: null,
      age: null,
      gender: null,
      location: null,
      followerShare: 0.2,
      nonFollowerShare: null,
      newViewerShare: null,
      returnViewerShare: null,
      other: ["brand_new_field"],
    });
  });
});
