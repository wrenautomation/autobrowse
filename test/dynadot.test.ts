import { describe, expect, it } from "vitest";
import { dynadot } from "../src/clients/dynadot.js";
import type { HttpClient } from "../src/clients/http.js";

const answers = (...bodies: object[]): HttpClient & { calls: number } => {
  const h = {
    calls: 0,
    async json<T>() {
      const body = bodies[Math.min(h.calls++, bodies.length - 1)];
      return { ok: true, status: 200, body: { R: body } as T, headers: new Headers() };
    },
  };
  return h as never;
};
const busy = { ResponseCode: -1, Error: "Too many requests. Please try again in 1 minute after." };
const balance = { ResponseCode: 0, BalanceList: [{ Currency: "USD", Amount: "35.00" }] };

describe("dynadot", () => {
  it("waits out 'Too many requests' and sends the call again, then gives up", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const once = answers(busy, balance);
    expect(await dynadot({ apiKey: "k", http: once, sleep }).balance()).toBe(35);
    expect(waits).toEqual([61_000]);
    const always = answers(busy);
    await expect(dynadot({ apiKey: "k", http: always, sleep }).balance()).rejects.toThrow(
      /Too many/,
    );
    expect(always.calls).toBe(3);
  });
});
