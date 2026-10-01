import { describe, expect, it } from "vitest";
import { slimListing, slimMessages } from "./reddit.js";

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
});
