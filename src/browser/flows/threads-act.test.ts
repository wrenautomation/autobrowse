import { describe, expect, it } from "vitest";
import { countOf, postOfCard } from "./threads-act.js";

const card = (over: Partial<Parameters<typeof postOfCard>[0]> = {}) => ({
  post: "/@example.shop/post/AbC123xyz",
  at: "2026-10-26T16:28:31.000Z",
  spans: ["example.shop", "7h", "We doubled bookings this month\n1\n/\n2", "1.2K", "43", "6", "4"],
  counts: { Like: "1.2K", Reply: "43", Repost: "6", Share: "4" },
  text: "example.shop\n7h\nWe doubled bookings this month",
  ...over,
});

describe("postOfCard", () => {
  it("reads the post, its text without carousel marks, and its like and reply counts", () => {
    expect(postOfCard(card())).toEqual({
      code: "AbC123xyz",
      url: "https://www.threads.com/@example.shop/post/AbC123xyz",
      username: "example.shop",
      text: "We doubled bookings this month",
      at: "2026-10-26T16:28:31.000Z",
      likes: 1200,
      replies: 43,
    });
  });

  it("reads a blank count as zero", () => {
    expect(postOfCard(card({ counts: { Like: "", Reply: "3" } }))).toMatchObject({
      likes: 0,
      replies: 3,
    });
  });

  it("leaves replies and cards with no post link", () => {
    expect(postOfCard(card({ text: "a\n2m\nReplying to @b\nhi" }))).toBeNull();
    expect(postOfCard(card({ post: "" }))).toBeNull();
  });
});

describe("countOf", () => {
  it("reads K and M", () => {
    expect(countOf("12")).toBe(12);
    expect(countOf("3.4M")).toBe(3_400_000);
    expect(countOf("")).toBeNull();
  });
});
