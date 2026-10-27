import { describe, expect, it } from "vitest";
import { searchRows } from "./tiktok-act.js";

describe("searchRows", () => {
  it("reads each video with its author, bio, counts and time", () => {
    const body = {
      item_list: [
        {
          id: "7000000000000000001",
          desc: "How we doubled bookings #smallbusiness",
          createTime: 1_790_000_000,
          author: { uniqueId: "example.shop", nickname: "Example Shop", signature: "We fix bikes" },
          stats: { diggCount: 120, commentCount: 8 },
        },
        { id: "7000000000000000002", desc: "no author" },
        { author: { uniqueId: "no.id" } },
      ],
    };
    expect(searchRows(body)).toEqual([
      {
        id: "7000000000000000001",
        url: "https://www.tiktok.com/@example.shop/video/7000000000000000001",
        username: "example.shop",
        name: "Example Shop",
        bio: "We fix bikes",
        text: "How we doubled bookings #smallbusiness",
        at: new Date(1_790_000_000_000).toISOString(),
        likes: 120,
        comments: 8,
      },
    ]);
  });

  it("answers no rows for a body with no list", () => {
    expect(searchRows(null)).toEqual([]);
    expect(searchRows({ status_code: 0 })).toEqual([]);
  });
});
