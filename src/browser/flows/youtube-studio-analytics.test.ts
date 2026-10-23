import { describe, expect, it } from "vitest";
import { studioTotalsOf } from "./youtube-studio-analytics.js";

describe("youtube studio totals", () => {
  it("reads the totals out of the cards, the first number winning", () => {
    const cards = {
      cards: [
        {
          config: {},
          lineChartCardData: { metricTotals: { views: 1095, avgViewDurationMillis: 11922 } },
        },
        {
          other: [
            {
              metricTotals: {
                avgPercentageWatched: 0.4415,
                shortsFeedImpressionsVtr: 29.13,
                views: 9,
              },
            },
          ],
        },
      ],
    };
    expect(studioTotalsOf([cards])).toEqual({
      viewedPct: 29.13,
      avgViewSecs: 11.922,
      avgViewPct: 44.15,
      views: 1095,
    });
  });

  it("is all null when no card carries totals", () => {
    expect(studioTotalsOf([{ cards: [] }, null, "x"])).toEqual({
      viewedPct: null,
      avgViewSecs: null,
      avgViewPct: null,
      views: null,
    });
  });
});
