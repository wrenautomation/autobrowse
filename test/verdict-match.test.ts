import { describe, expect, it } from "vitest";
import { matchSent, sameWords, settle, type VerifyRow } from "../src/sites/verdict.js";

const since = "2026-10-16T12:00:00.000Z";
const words = "Thanks for the write-up, the part about retries with backoff matched what we saw.";
const row = (o: Partial<VerifyRow>): VerifyRow => ({
  words: "something else entirely, long enough to not be a prefix of ours",
  at: "2026-10-16T12:01:00.000Z",
  id: "r1",
  url: null,
  ...o,
});

describe("matchSent", () => {
  it("finds our words since the send, cut previews and escapes too", () => {
    expect(sameWords(`${words.slice(0, 60)}…`, words)).toBe(true);
    expect(sameWords("Thanks &amp; more", "Thanks & more")).toBe(true);
    const read = { rows: [row({ words, id: "c9", url: "u" })], order: "newest", complete: false };
    expect(matchSent(read as never, { words, since })).toEqual({
      seen: "found",
      id: "c9",
      url: "u",
      at: "2026-10-16T12:01:00.000Z",
    });
  });

  it("skips someone else's row and a row from before the send", () => {
    const read = {
      rows: [row({ words, mine: false }), row({ words, at: "2026-10-15T12:00:00.000Z" })],
      order: "newest" as const,
      complete: false,
    };
    // The oldest row is older than the send: nothing newer was cut, so absent.
    expect(matchSent(read, { words, since })).toEqual({ seen: "absent" });
  });

  it("absent needs a read that reaches back past the send", () => {
    const cut = { rows: [row({})], order: "newest" as const, complete: false };
    expect(matchSent(cut, { words, since }).seen).toBe("unclear");
    expect(matchSent({ ...cut, order: "ranked" }, { words, since }).seen).toBe("unclear");
    expect(matchSent({ ...cut, order: "ranked", complete: true }, { words, since }).seen).toBe(
      "absent",
    );
  });

  it("a lagging list never proves absent", () => {
    const read = { rows: [], order: "newest" as const, complete: true };
    expect(settle(read, { words, since, lags: "lists a video once processed" })).toEqual({
      seen: "unclear",
      why: "lists a video once processed",
    });
    expect(
      settle({ seen: "found", id: "v1", url: null, at: null }, { words, since }),
    ).toMatchObject({ seen: "found" });
  });
});
