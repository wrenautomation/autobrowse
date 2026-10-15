import { describe, expect, it } from "vitest";
import { slimListing, slimMessages, slimUserData } from "./reddit.js";

describe("reddit slimming", () => {
  it("keeps a message's fields and its replies, drops the rest", () => {
    const out = slimMessages({
      kind: "Listing",
      data: {
        after: "t4_b",
        children: [
          {
            kind: "t4",
            data: {
              id: "a",
              name: "t4_a",
              author: "someone",
              dest: "us",
              subject: "hi",
              body: "hello",
              created_utc: 1,
              new: true,
              modhash: "secret",
              replies: {
                kind: "Listing",
                data: { children: [{ kind: "t4", data: { id: "b", body: "back", modhash: "x" } }] },
              },
            },
          },
        ],
      },
    }) as { data: { after: string; children: Array<{ data: Record<string, unknown> }> } };
    expect(out.data.after).toBe("t4_b");
    const m = out.data.children[0]?.data ?? {};
    expect(m.subject).toBe("hi");
    expect("modhash" in m).toBe(false);
    const replies = m.replies as { data: { children: Array<{ data: Record<string, unknown> }> } };
    expect(replies.data.children[0]?.data).toEqual({ id: "b", body: "back" });
  });

  it("slims a listing of things", () => {
    const out = slimListing({
      data: { children: [{ kind: "t3", data: { id: "p", title: "t", modhash: "no" } }] },
    }) as { data: { children: Array<{ data: Record<string, unknown> }> } };
    expect(out.data.children[0]?.data).toEqual({ id: "p", title: "t" });
  });

  it("keeps who wrote a thing (`author_fullname`) and the title a comment sits under", () => {
    const out = slimListing({
      data: {
        children: [
          { kind: "t1", data: { id: "c", author_fullname: "t2_x", link_title: "Hi", ups: 3 } },
        ],
      },
    }) as { data: { children: Array<{ data: Record<string, unknown> }> } };
    expect(out.data.children[0]?.data).toEqual({
      id: "c",
      author_fullname: "t2_x",
      link_title: "Hi",
    });
  });

  it("slims accounts by id to a card's age and karma", () => {
    expect(
      slimUserData({
        t2_a: {
          name: "a",
          created_utc: 1,
          link_karma: 2,
          comment_karma: 3,
          profile_img: "u",
          x: 9,
        },
        t2_b: { name: "b", created_utc: 4, link_karma: 0, comment_karma: 0, subreddit: { y: 1 } },
        junk: { name: "no" },
      }),
    ).toEqual({
      t2_a: { name: "a", created_utc: 1, link_karma: 2, comment_karma: 3, profile_img: "u" },
      t2_b: { name: "b", created_utc: 4, link_karma: 0, comment_karma: 0 },
    });
    expect(slimUserData(null)).toEqual({});
  });
});
