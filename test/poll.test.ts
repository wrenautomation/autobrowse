import { describe, expect, it } from "vitest";
import { pollWaits } from "../src/sites/poll.js";

describe("pollWaits", () => {
  it("grows from 5 s to 20 s and adds up to the total", () => {
    expect(pollWaits(0)).toEqual([]);
    expect(pollWaits(120_000)).toEqual([5, 10, 15, 20, 20, 20, 20, 10].map((s) => s * 1000));
    const five = pollWaits(300_000);
    expect(five).toHaveLength(17);
    expect(five.reduce((a, b) => a + b, 0)).toBe(300_000);
    expect(Math.max(...five)).toBe(20_000);
  });
});
