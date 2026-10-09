import { describe, expect, it } from "vitest";
import {
  agoAt,
  agoOf,
  placeUrl,
  type RawReview,
  reviewsOf,
  starsOf,
  timesIn,
} from "../src/browser/flows/google-reviews.js";
import { web } from "../src/sites/web.js";

const A = "ChZDSUhNMG9nS0VJQ0FnSUN5bnRoZXRpYzE";
const B = "ChZDSUhNMG9nS0VJQ0FnSUN5bnRoZXRpYzI";
const C = "ChZDSUhNMG9nS0VJQ0FnSUN5bnRoZXRpYzM";
// The rpc's payload is a JSON string inside the envelope: its quotes come escaped.
const body = `)]}'\n[["wrb.fr","qv9Egd","[null,[[[\\"${A}\\",[\\"0x0:0x1111aaaa\\",null,1780330665490556,1780330665490556]],[\\"${B}\\",[\\"0x0:0x1111aaaa\\",null,1773363081732300,1773363081732300]]]]]"]]`;

const NOW = new Date("2026-10-09T12:00:00Z");

const raw = (r: Partial<RawReview>): RawReview => ({
  id: A,
  author: "Avery Quinlan",
  authorUrl: "https://www.google.com/maps/contrib/1?hl=en",
  starsLabel: "5 stars",
  text: "Great service.",
  ago: "4 months ago",
  reply: null,
  ...r,
});

describe("google reviews", () => {
  it("opens the place by its Place ID, in English", () => {
    const u = new URL(placeUrl("ChIJsynthetic_place-0001"));
    expect(u.pathname).toBe("/maps/place/");
    expect(u.searchParams.get("q")).toBe("place_id:ChIJsynthetic_place-0001");
    expect(u.searchParams.get("hl")).toBe("en");
  });

  it("reads stars both ways Maps prints them", () => {
    expect(starsOf("5 stars")).toBe(5);
    expect(starsOf("1 star")).toBe(1);
    expect(starsOf("4/5")).toBe(4);
    expect(starsOf("Rated")).toBeNull();
    expect(starsOf(null)).toBeNull();
  });

  it("splits a hotel's age from its source", () => {
    expect(agoOf("2 hours ago on Google")).toEqual({ ago: "2 hours ago", source: "Google" });
    expect(agoOf("a week ago on Tripadvisor")).toEqual({
      ago: "a week ago",
      source: "Tripadvisor",
    });
    expect(agoOf("3 months ago")).toEqual({ ago: "3 months ago", source: "Google" });
  });

  it("counts an age back from now", () => {
    expect(agoAt("2 hours ago", NOW)).toBe("2026-10-09T10:00:00.000Z");
    expect(agoAt("a day ago", NOW)).toBe("2026-10-08T12:00:00.000Z");
    expect(agoAt("Edited a year ago", NOW)).toBe("2025-10-09T12:00:00.000Z");
    expect(agoAt("yesterday", NOW)).toBeNull();
  });

  it("finds each review's time in the rpc, by id", () => {
    const t = timesIn([body], [A, B, C]);
    expect(t.get(A)).toBe(new Date(1780330665490.556).toISOString());
    expect(t.get(B)).toBe(new Date(1773363081732.3).toISOString());
    expect(t.has(C)).toBe(false);
  });

  it("keeps Google's reviews once each, with times, replies and the limit", () => {
    const got = reviewsOf(
      [
        raw({ text: "Great service, fast too. … More" }),
        raw({ author: "Dup" }),
        raw({
          id: B,
          author: "Jordan Lee",
          starsLabel: "2/5",
          ago: "Edited 6 months ago on Google",
          text: "",
          reply: { text: "Sorry to hear it, call us.", ago: "5 months ago" },
        }),
        raw({ id: C, ago: "a week ago on Tripadvisor" }),
      ],
      [body],
      10,
      NOW,
    );
    expect(got.map((r) => r.id)).toEqual([A, B]);
    expect(got[0]).toMatchObject({
      author: "Avery Quinlan",
      stars: 5,
      text: "Great service, fast too.",
      ago: "4 months ago",
      edited: false,
      estimated: false,
      reply: null,
    });
    expect(got[1]).toMatchObject({
      stars: 2,
      text: "",
      edited: true,
      ago: "Edited 6 months ago",
      reply: { text: "Sorry to hear it, call us.", ago: "5 months ago" },
    });
    expect(got[1]?.at).toBe(new Date(1773363081732.3).toISOString());
    const [guess] = reviewsOf([raw({ ago: "3 weeks ago on Google" })], [], 1, NOW);
    expect(guess).toMatchObject({ at: "2026-09-18T12:00:00.000Z", estimated: true });
    expect(reviewsOf([raw({}), raw({ id: B })], [], 1, NOW)).toHaveLength(1);
  });

  it("routes the read to the signed-in Google profile", () => {
    const r = web.routes.find((x) => x.path === "/place/reviews");
    expect(r?.browser).toEqual({ flow: "google/maps-reviews", signedIn: true });
    expect(r?.request.safeParse({ placeId: "ChIJsynthetic_place-0001" }).success).toBe(true);
    expect(r?.request.safeParse({ placeId: "x" }).success).toBe(false);
  });
});
