import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApiKeyInput, keyId, memoryKeys } from "credvault";
import { describe, expect, it } from "vitest";
import {
  envSource,
  fileKeyUses,
  fileSpent,
  fingerprint,
  memoryKeyUses,
  memorySpent,
  NoLiveKey,
  nextMonthUtc,
  outOfCredit,
  ringCount,
  ringKeys,
  withKey,
} from "../src/reach/key-ring.js";
import { vaultSource } from "../src/reach/key-source.js";
import { companySearch, people, search, WebMiss } from "../src/reach/web.js";

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
    const vars = envOf({
      NUM_EXA: "2",
      EXA_API_KEY_1: "synthetic-a",
      EXA_API_KEY_2: "synthetic-b",
    });
    const source = envSource(vars);
    const spent = memorySpent();
    const sent: string[] = [];
    const send = async (key: string) => {
      sent.push(key);
      return key === "synthetic-a"
        ? new Response('{"error":"insufficient balance"}', { status: 402 })
        : new Response("{}");
    };
    let t = noon;
    expect((await withKey("EXA", source, spent, send, { now: () => t })).ok).toBe(true);
    expect((await withKey("EXA", source, spent, send, { now: () => t })).ok).toBe(true);
    expect(sent).toEqual(["synthetic-a", "synthetic-b", "synthetic-b"]);
    expect(spent.until(fingerprint("synthetic-a"))).toBe(Date.UTC(2026, 10, 1));
    expect(await ringCount("EXA", source, spent, t)).toEqual({ live: 1, held: 2 });
    t = Date.UTC(2026, 10, 1, 0, 1);
    await withKey("EXA", source, spent, send, { now: () => t });
    expect(sent.slice(3)).toEqual(["synthetic-a", "synthetic-b"]);
  });

  it("leaves any other failure to the caller, on the same key", async () => {
    const source = envSource(
      envOf({ NUM_EXA: "2", EXA_API_KEY_1: "synthetic-a", EXA_API_KEY_2: "synthetic-b" }),
    );
    const spent = memorySpent();
    const res = await withKey(
      "EXA",
      source,
      spent,
      async () => new Response("down", { status: 500 }),
    );
    expect(res.status).toBe(500);
    expect(spent.until(fingerprint("synthetic-a"))).toBeNull();
  });

  it("every key spent: says when, never a key value", async () => {
    const e = await withKey(
      "EXA",
      envSource(envOf({ EXA_API_KEY: "synthetic-secret" })),
      memorySpent(),
      async () => new Response("", { status: 402 }),
      { now: () => noon },
    ).catch((x) => x);
    expect(e).toBeInstanceOf(NoLiveKey);
    expect(e.message).toBe("every EXA key is out of credit (1 held) until 2026-11-01");
    expect(nextMonthUtc(Date.UTC(2026, 11, 31, 23))).toBe(Date.UTC(2027, 0, 1));
  });

  it("spent marks survive a restart, by fingerprint only", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ring-")), "spent-keys.json");
    fileSpent(path).mark(fingerprint("synthetic-a"), 99);
    expect(fileSpent(path).until(fingerprint("synthetic-a"))).toBe(99);
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

  it("firm search moves past a spent key; every key spent is a 402", async () => {
    const env = envOf({ EXA_API_KEY: "synthetic-a", NUM_EXA: "1", EXA_API_KEY_1: "synthetic-b" });
    const ok = await companySearch("q", { env, fetch: exa("synthetic-a"), spent: memorySpent() });
    expect(ok.results).toEqual([]);
    const all = await companySearch("q", {
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

const key = (account: string, secret: string, more: Partial<ApiKeyInput> = {}): ApiKeyInput => ({
  site: "exa",
  account,
  owner: "wren",
  secret,
  purposes: [],
  status: "live",
  madeAt: "2026-10-01T00:00:00.000Z",
  ...more,
});
const ok = async () => new Response("{}");
const at = () => noon;
const vars = envOf({ EXA_API_KEY: "synthetic-from-names" });

describe("the vault as the ring", () => {
  it("takes the vault's keys in ring order before the env names", async () => {
    const store = memoryKeys([
      key("b", "synthetic-b"),
      key("a", "synthetic-a", { purposes: ["default"] }),
    ]);
    const source = vaultSource({ store, owner: "wren", env: vars, now: at });
    const sent: string[] = [];
    await withKey("EXA", source, memorySpent(), async (k) => {
      sent.push(k);
      return ok();
    });
    expect(sent).toEqual(["synthetic-a"]);
    expect((await source("exa", {})).map((k) => k.address)).toEqual(["exa@a", "exa@b"]);
  });

  it("falls back to the env ring when the vault holds no key for the vendor", async () => {
    const source = vaultSource({ store: memoryKeys(), owner: "wren", env: vars, now: at });
    const got = await source("exa", {});
    expect(got.map((k) => [k.name, k.address])).toEqual([["EXA_API_KEY", null]]);
  });

  it("falls back to the env ring when the vault fails, and tells onError once per ttl", async () => {
    const store = {
      ...memoryKeys(),
      list: async () => {
        throw new Error("vault down");
      },
    };
    const errors: unknown[] = [];
    let t = noon;
    const source = vaultSource({
      store,
      owner: "wren",
      env: vars,
      ttlMs: 1000,
      onError: (e) => errors.push(e),
      now: () => t,
    });
    expect((await source("exa", {})).length).toBe(1);
    expect((await source("exa", {})).length).toBe(1);
    expect(errors).toHaveLength(1);
    t += 2000;
    await source("exa", {});
    expect(errors).toHaveLength(2);
  });

  it("caches a vendor's ring for the ttl", async () => {
    let lists = 0;
    const inner = memoryKeys([key("a", "synthetic-a")]);
    const store = {
      ...inner,
      list: async () => {
        lists += 1;
        return inner.list();
      },
    };
    let t = noon;
    const source = vaultSource({ store, owner: "wren", env: vars, ttlMs: 1000, now: () => t });
    await source("exa", {});
    await source("exa", {});
    expect(lists).toBe(1);
    t += 1500;
    await source("exa", {});
    expect(lists).toBe(2);
  });

  describe("a named account", () => {
    const store = memoryKeys([
      key("a", "synthetic-a"),
      key("spent", "synthetic-s", { status: "spent", spentUntil: "2026-11-01T00:00:00.000Z" }),
      key("gone", "synthetic-g", { status: "revoked", revokedAt: "2026-10-02T00:00:00.000Z" }),
      key("theirs", "synthetic-t", { owner: "client" }),
      { ...key("main", "synthetic-m"), site: "brave" },
    ]);
    const source = vaultSource({ store, owner: "wren", env: vars, now: at });

    it("runs on that key and nothing else", async () => {
      const sent: string[] = [];
      await withKey(
        "EXA",
        source,
        memorySpent(),
        async (k) => {
          sent.push(k);
          return ok();
        },
        { account: "exa@a" },
      );
      expect(sent).toEqual(["synthetic-a"]);
    });

    it.each([
      ["exa@nope", "no key exa@nope"],
      ["exa@spent", "exa@spent is spent until 2026-11-01"],
      ["exa@gone", "exa@gone is revoked"],
      ["exa@theirs", "no key exa@theirs"],
      ["brave@main", "brave@main is not a exa key"],
    ])("%s is refused: %s", async (account, why) => {
      const refused: string[] = [];
      const sent: string[] = [];
      const e = await withKey(
        "EXA",
        source,
        memorySpent(),
        async (k) => {
          sent.push(k);
          return ok();
        },
        { account, onRefuse: (a, w) => void refused.push(`${a}: ${w}`) },
      ).catch((x) => x);
      expect(e).toBeInstanceOf(NoLiveKey);
      expect(e.message).toBe(why);
      expect(e.account).toBe(account);
      expect(sent).toEqual([]);
      expect(refused).toEqual([`${account}: ${why}`]);
    });

    it("an env-only ring has no addresses: a named account finds nothing", async () => {
      const e = await withKey("EXA", envSource(vars), memorySpent(), ok, {
        account: "exa@env-0",
      }).catch((x) => x);
      expect(e.message).toBe("no key exa@env-0");
    });
  });

  it("a 402 marks the key spent and moves on to the next", async () => {
    const store = memoryKeys([key("a", "synthetic-a"), key("b", "synthetic-b")]);
    const source = vaultSource({ store, owner: "wren", env: vars, now: at });
    const spent = memorySpent();
    const sent: string[] = [];
    const res = await withKey(
      "EXA",
      source,
      spent,
      async (k) => {
        sent.push(k);
        return k === "synthetic-a" ? new Response("", { status: 402 }) : ok();
      },
      { now: at },
    );
    expect(res.ok).toBe(true);
    expect(sent).toEqual(["synthetic-a", "synthetic-b"]);
    expect(spent.until(keyId("synthetic-a"))).toBe(Date.UTC(2026, 10, 1));
  });

  it("a named key that answers 402 is spent and the call says so", async () => {
    const store = memoryKeys([key("a", "synthetic-a")]);
    const source = vaultSource({ store, owner: "wren", env: vars, now: at });
    const e = await withKey(
      "EXA",
      source,
      memorySpent(),
      async () => new Response("", { status: 402 }),
      { account: "exa@a", now: at },
    ).catch((x) => x);
    expect(e.message).toBe("exa@a is spent until 2026-11-01");
  });

  describe("a call cap", () => {
    const capped = key("a", "synthetic-a", { cap: { amount: 2, unit: "calls" } });
    const run = async (uses = memoryKeyUses(), spent = memorySpent()) => {
      const source = vaultSource({
        store: memoryKeys([capped, key("b", "synthetic-b")]),
        owner: "wren",
        env: vars,
        now: at,
      });
      const sent: string[] = [];
      await withKey(
        "EXA",
        source,
        spent,
        async (k) => {
          sent.push(k);
          return ok();
        },
        { uses, now: at },
      );
      return sent[0];
    };

    it("is counted per send, and a key at its cap is skipped and marked spent until the 1st", async () => {
      const uses = memoryKeyUses();
      const spent = memorySpent();
      expect(await run(uses, spent)).toBe("synthetic-a");
      expect(await run(uses, spent)).toBe("synthetic-a");
      expect(await run(uses, spent)).toBe("synthetic-b");
      expect(spent.until(keyId("synthetic-a"))).toBe(Date.UTC(2026, 10, 1));
    });

    it("counts again from zero in a new month", async () => {
      const uses = memoryKeyUses();
      uses.add(keyId("synthetic-a"), "2026-09");
      uses.add(keyId("synthetic-a"), "2026-09");
      expect(await run(uses)).toBe("synthetic-a");
    });

    it("lives in a file by id and month, never a value", () => {
      const path = join(mkdtempSync(join(tmpdir(), "uses-")), "key-uses.json");
      const uses = fileKeyUses(path);
      uses.add("abc", "2026-10");
      uses.add("abc", "2026-10");
      expect(fileKeyUses(path).count("abc", "2026-10")).toBe(2);
      expect(fileKeyUses(path).count("abc", "2026-11")).toBe(0);
    });
  });

  it("onUse runs before each send, with the key's address and id", async () => {
    const store = memoryKeys([key("a", "synthetic-a"), key("b", "synthetic-b")]);
    const source = vaultSource({ store, owner: "wren", env: vars, now: at });
    const used: string[] = [];
    await withKey(
      "EXA",
      source,
      memorySpent(),
      async (k) => (k === "synthetic-a" ? new Response("", { status: 402 }) : ok()),
      { now: at, onUse: (k) => void used.push(`${k.address} ${k.id}`) },
    );
    expect(used).toEqual([`exa@a ${keyId("synthetic-a")}`, `exa@b ${keyId("synthetic-b")}`]);
  });

  it("a named exa key on search runs on that key only; a miss is not retried on another backend", async () => {
    const store = memoryKeys([key("a", "synthetic-a")]);
    const keys = vaultSource({ store, owner: "wren", env: vars, now: at });
    const deps = {
      env: envOf({ BRAVE_API_KEY: "synthetic-brave" }),
      keys,
      spent: memorySpent(),
      fetch: (async () => new Response(JSON.stringify({ results: [] }))) as unknown as typeof fetch,
    };
    const call = (account: string) => ({
      account,
      onUse: async () => {},
      onRefuse: async () => {},
    });
    const hit = await search("q", { ...deps, call: call("exa@a") });
    expect(hit.via).toBe("exa");
    const miss = await search("q", { ...deps, call: call("exa@nope") }).catch((e) => e);
    expect(miss).toBeInstanceOf(WebMiss);
    expect(miss.status).toBe(400);
    expect(miss.message).toContain("no key exa@nope");
  });
});
