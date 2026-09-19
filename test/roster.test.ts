import { describe, expect, it } from "vitest";
import { appendEntries, rosterAddresses } from "../src/clients/roster.js";

const ROSTER = `# comment stays
[signature]
text = "hi"

[[senders]]
address = "a@x.test"
display_name = "A"
niches = "all"
`;

describe("appendEntries", () => {
  it("appends new senders and leaves the rest byte-for-byte", () => {
    const out = appendEntries(ROSTER, [
      { address: "B@x.test", displayName: "B", niches: "all" },
      { address: "c@x.test", displayName: "C", niches: ["agencies", "shopify"] },
    ]);
    expect(out.added).toEqual(["b@x.test", "c@x.test"]);
    expect(out.text.startsWith(ROSTER)).toBe(true);
    expect(out.text).toContain('niches = ["agencies", "shopify"]');
    expect(rosterAddresses(out.text)).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
  });
  it("is idempotent", () => {
    const once = appendEntries(ROSTER, [{ address: "a@x.test", displayName: "A", niches: "all" }]);
    expect(once.added).toEqual([]);
    expect(once.text).toBe(ROSTER);
  });
});
