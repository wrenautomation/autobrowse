import { describe, expect, it } from "vitest";
import { backoff, httpClient, safeUrl } from "../src/clients/http.js";

function fakeFetch(
  script: Array<{ status: number; body?: string; headers?: Record<string, string> } | Error>,
) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method ?? "GET" });
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return new Response(next.body ?? null, { status: next.status, headers: next.headers ?? {} });
  };
  return { fetch, calls };
}

const client = (fetch: (url: string, init?: RequestInit) => Promise<Response>) =>
  httpClient({ fetch, sleep: async () => undefined, random: () => 0 });

describe("httpClient", () => {
  it("parses JSON and reports non-JSON as null", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: '{"a":1}' }, { status: 204 }]);
    const c = client(fetch);
    expect(await c.json<{ a: number }>("https://x.test/p")).toMatchObject({
      status: 200,
      body: { a: 1 },
    });
    expect((await c.json("https://x.test/p")).body).toBeNull();
  });

  it("retries a GET on 503 and honours Retry-After, then returns the last answer", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 503, headers: { "retry-after": "1" } },
      { status: 503 },
      { status: 200, body: "[]" },
    ]);
    const r = await client(fetch).json("https://x.test/list?token=secret");
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("retries a POST only on 429", async () => {
    const a = fakeFetch([{ status: 429 }, { status: 201, body: "{}" }]);
    expect(
      (await client(a.fetch).json("https://x.test/c", { method: "POST", body: {} })).status,
    ).toBe(201);
    const b = fakeFetch([{ status: 503 }, { status: 201 }]);
    expect(
      (await client(b.fetch).json("https://x.test/c", { method: "POST", body: {} })).status,
    ).toBe(503);
    expect(b.calls).toHaveLength(1);
  });

  it("gives up after the attempt budget and never leaks the query string", async () => {
    const { fetch, calls } = fakeFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    await expect(client(fetch).json("https://x.test/p?key=secret")).rejects.toThrow(
      /^GET https:\/\/x\.test\/p: HTTP 0 TypeError$/,
    );
    expect(calls).toHaveLength(3);
  });
});

describe("backoff", () => {
  it("uses Retry-After seconds when present, capped", () => {
    expect(backoff(1, "2")).toBe(2000);
    expect(backoff(1, "600")).toBe(10_000);
  });
  it("grows with jitter otherwise", () => {
    expect(backoff(1, null, () => 1)).toBe(500);
    expect(backoff(3, null, () => 1)).toBe(2000);
    expect(backoff(9, null, () => 1)).toBe(10_000);
  });
});

describe("safeUrl", () => {
  it("drops the query", () => {
    expect(safeUrl("https://a.test/x/y?token=1#f")).toBe("https://a.test/x/y");
    expect(safeUrl("nope")).toBe("<url>");
  });
});
