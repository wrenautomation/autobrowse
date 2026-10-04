import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fileSpent,
  fingerprint,
  memorySpent,
  NoLiveKey,
  nextMonthUtc,
  outOfCredit,
  ringCount,
  ringKeys,
  withKey,
} from "../src/reach/key-ring.js";
import { people, search, WebMiss } from "../src/reach/web.js";

const envOf = (vars: Record<string, string>) => async (n: string) => vars[n];
const noon = Date.UTC(2026, 9, 3, 12);

describe("exa key ring", () => {
  it("reads the plain key first, then NUM_EXA numbered ones, each value once", async () => {
    const env = envOf({
      EXA_API_KEY: "synthetic-a",
      NUM_EXA: "3",
      EXA_API_KEY_1: "synthetic-a",
      EXA_API_KEY_2: "synthetic-b",
      EXA_API_KEY_4: "past-the-count",
    });
    expect((await ringKeys("EXA", env)).map((k) => k.name)).toEqual([
      "EXA_API_KEY",
      "EXA_API_KEY_2",
    ]);
    expect(await ringKeys("EXA", envOf({}))).toEqual([]);
  });

  it("knows an out-of-credit answer from a rate limit or a server error", () => {
    expect(outOfCredit(402, "")).toBe(true);
    expect(outOfCredit(429, '{"error":"You have run out of credits"}')).toBe(true);
    expect(outOfCredit(429, '{"error":"rate limit"}')).toBe(false);
    expect(outOfCredit(500, "credits")).toBe(false);
  });

  it("moves past a spent key, remembers it until the 1st, never calls it again before then", async () => {
    const env = envOf({ NUM_EXA: "2", EXA_API_KEY_1: "synthetic-a", EXA_API_KEY_2: "synthetic-b" });
    const spent = memorySpent();
    const sent: string[] = [];
    const send = async (key: string) => {
      sent.push(key);
      return key === "synthetic-a"
        ? new Response('{"error":"insufficient balance"}', { status: 402 })
        : new Response("{}");
    };
    let t = noon;
    expect((await withKey("EXA", env, spent, send, () => t)).ok).toBe(true);
    expect((await withKey("EXA", env, spent, send, () => t)).ok).toBe(true);
    expect(sent).toEqual(["synthetic-a", "synthetic-b", "synthetic-b"]);
    expect(spent.until(fingerprint("synthetic-a"))).toBe(Date.UTC(2026, 10, 1));
    expect(await ringCount("EXA", env, spent, t)).toEqual({ live: 1, held: 2 });
    t = Date.UTC(2026, 10, 1, 0, 1);
    await withKey("EXA", env, spent, send, () => t);
    expect(sent.slice(3)).toEqual(["synthetic-a", "synthetic-b"]);
  });

  it("leaves any other failure to the caller, on the same key", async () => {
    const env = envOf({ NUM_EXA: "2", EXA_API_KEY_1: "synthetic-a", EXA_API_KEY_2: "synthetic-b" });
    const spent = memorySpent();
    const res = await withKey("EXA", env, spent, async () => new Response("down", { status: 500 }));
    expect(res.status).toBe(500);
    expect(spent.until(fingerprint("synthetic-a"))).toBeNull();
  });

  it("every key spent: says when, never a key value", async () => {
    const env = envOf({ EXA_API_KEY: "synthetic-secret" });
    const e = await withKey(
      "EXA",
      env,
      memorySpent(),
      async () => new Response("", { status: 402 }),
      () => noon,
    ).catch((x) => x);
    expect(e).toBeInstanceOf(NoLiveKey);
    expect(e.message).toBe("every EXA key is out of credit (1 held) until 2026-11-01");
    expect(nextMonthUtc(Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2027, 0, 1));
  });

  it("spent marks survive a restart, by fingerprint only", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ring-")), "spent-keys.json");
    fileSpent(path).mark(fingerprint("synthetic-a"), 99);
    expect(fileSpent(path).until(fingerprint("synthetic-a"))).toBe(99);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path, "utf8")).not.toContain("synthetic-a");
  });
});

describe("exa routes on the ring", () => {
  const exa = (spentKey: string) =>
    (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["x-api-key"];
      return key === spentKey
        ? new Response("", { status: 402 })
        : new Response(JSON.stringify({ results: [] }));
    }) as unknown as typeof fetch;

  it("people answers on the next key; every key spent is a 402, not a retry", async () => {
    const env = envOf({ EXA_API_KEY: "synthetic-a", NUM_EXA: "1", EXA_API_KEY_1: "synthetic-b" });
    const spent = memorySpent();
    expect((await people("q", { env, fetch: exa("synthetic-a"), spent })).people).toEqual([]);
    const all = await people("q", {
      env: envOf({ EXA_API_KEY: "synthetic-a" }),
      fetch: exa("synthetic-a"),
      spent: memorySpent(),
    }).catch((e) => e);
    expect(all).toBeInstanceOf(WebMiss);
    expect(all.status).toBe(402);
  });

  it("search skips exa when every key is spent and asks the next backend", async () => {
    const spent = memorySpent();
    spent.mark(fingerprint("synthetic-a"), Date.now() + 86_400_000);
    const r = await search(
      "q",
      {
        env: envOf({ EXA_API_KEY: "synthetic-a", BRAVE_API_KEY: "synthetic-brave" }),
        fetch: (async () =>
          new Response(JSON.stringify({ web: { results: [] } }))) as unknown as typeof fetch,
        spent,
      },
      { order: ["exa", "brave"] },
    );
    expect(r.via).toBe("brave");
    expect(r.tried[0]?.why).toMatch(/out of credit/);
  });
});
