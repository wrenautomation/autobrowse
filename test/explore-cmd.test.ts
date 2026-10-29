import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS, no types
import { tokenFileFor as fast } from "../bin/explore-cmd.mjs";
import { tokenFileFor } from "../src/explore/journal.js";

describe("bin/explore-cmd.mjs", () => {
  it("finds the same token file as the explore server", () => {
    expect(fast(9090)).toBe(tokenFileFor(9090));
    expect(fast(9123)).toBe(tokenFileFor(9123));
  });
});
