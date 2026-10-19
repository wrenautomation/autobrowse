import { applyProjection, keyId, memoryEnvStore, memoryKeys } from "credvault";
import { describe, expect, it } from "vitest";
import { KeyError, rotateKey, rotationOf } from "../src/auth/keys.js";
import { ownerKeysIn } from "../src/reach/key-source.js";

const NOW = Date.UTC(2026, 9, 19, 12);
const AT = new Date(NOW).toISOString();

const old = (extra: object = {}) => ({
  site: "anthropic",
  account: "prod",
  owner: "wren",
  secret: "synthetic-old",
  purposes: ["default", "drafts"],
  status: "live" as const,
  madeAt: "2026-09-01T00:00:00.000Z",
  via: "anthropic@william",
  vendorId: "prod-old",
  cap: { amount: 50, unit: "calls" as const },
  previous: [{ id: "0123456789ab", revokedAt: "2026-08-01T00:00:00.000Z" }],
  ...extra,
});

describe("rotateKey", () => {
  it("carries purposes, via and cap, and puts the old id first in previous", async () => {
    const store = memoryKeys([old()]);
    const out = await rotateKey(store, "anthropic@prod", "synthetic-new", {
      owner: "wren",
      now: NOW,
      vendorId: "prod-new",
    });
    expect(out.old).toEqual({ id: keyId("synthetic-old"), vendorId: "prod-old" });
    const key = await store.get("anthropic@prod");
    expect(key).toMatchObject({
      secret: "synthetic-new",
      purposes: ["default", "drafts"],
      via: "anthropic@william",
      cap: { amount: 50, unit: "calls" },
      vendorId: "prod-new",
      status: "live",
      madeAt: AT,
    });
    expect(key?.previous).toEqual([
      { id: keyId("synthetic-old"), vendorId: "prod-old", revokedAt: AT },
      { id: "0123456789ab", revokedAt: "2026-08-01T00:00:00.000Z" },
    ]);
    expect(await store.list()).toHaveLength(1);
  });

  it("takes via from the caller only when the old key names none; a hand rotation has no vendor id", async () => {
    const store = memoryKeys([old({ via: undefined })]);
    await rotateKey(store, "anthropic@prod", "synthetic-new", {
      owner: "wren",
      now: NOW,
      via: "anthropic",
    });
    const key = await store.get("anthropic@prod");
    expect(key?.via).toBe("anthropic");
    expect(key?.vendorId).toBeUndefined();
  });

  it("the projection follows: the old id is gone from the env names", async () => {
    const store = memoryKeys([
      old(),
      old({ account: "bulk", secret: "synthetic-other", purposes: [] }),
    ]);
    const env = memoryEnvStore();
    await applyProjection(env, await ownerKeysIn(store, "wren"), { vendors: ["anthropic"] });
    expect(Object.values(env.values)).toContain("synthetic-old");
    await rotateKey(store, "anthropic@prod", "synthetic-new", { owner: "wren", now: NOW });
    const out = await applyProjection(env, await ownerKeysIn(store, "wren"), {
      vendors: ["anthropic"],
    });
    expect(out.put.length).toBeGreaterThan(0);
    const values = Object.values(env.values);
    expect(values).toContain("synthetic-new");
    expect(values).toContain("synthetic-other");
    expect(values).not.toContain("synthetic-old");
  });

  it("refuses a missing key, another owner's, another vendor's, a same value and a value held elsewhere", async () => {
    const store = memoryKeys([
      old(),
      old({ account: "bulk", secret: "synthetic-bulk", purposes: [] }),
      old({ site: "exa", account: "main", secret: "synthetic-exa", purposes: [] }),
      old({ account: "theirs", owner: "someone", secret: "synthetic-theirs", purposes: [] }),
    ]);
    const o = { owner: "wren", now: NOW };
    await expect(rotateKey(store, "anthropic@nope", "x1", o)).rejects.toMatchObject({
      status: 404,
    });
    await expect(rotateKey(store, "anthropic@theirs", "x2", o)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      rotateKey(store, "exa@main", "x3", { ...o, vendor: "anthropic" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(rotateKey(store, "anthropic@prod", "synthetic-old", o)).rejects.toThrow(
      "already anthropic@prod",
    );
    await expect(rotateKey(store, "anthropic@prod", "synthetic-bulk", o)).rejects.toThrow(
      "already anthropic@bulk",
    );
    await expect(rotateKey(store, "bad address", "x4", o)).rejects.toBeInstanceOf(KeyError);
    expect((await store.get("anthropic@prod"))?.secret).toBe("synthetic-old");
  });
});

describe("rotationOf", () => {
  it("names the vendor's run: workflow, run key of the day, plan with the old key's login", async () => {
    const store = memoryKeys([old()]);
    expect(await rotationOf(store, "anthropic@prod", { owner: "wren", now: NOW })).toEqual({
      workflow: "anthropic-console-api-key",
      key: "rotate-prod-20261019",
      plan: {
        name: "prod-20261019",
        account: "prod",
        replaces: "anthropic@prod",
        login: "anthropic@william",
      },
    });
  });

  it("leaves the login out when the key was not made from an Anthropic login", async () => {
    const store = memoryKeys([old({ via: "google@william" })]);
    const r = await rotationOf(store, "anthropic@prod", { owner: "wren", now: NOW });
    expect(r.plan).not.toHaveProperty("login");
  });

  it("a vendor with no flow is 501, an unknown address 404, a bad one 400", async () => {
    const store = memoryKeys([old({ site: "exa", account: "main" })]);
    const o = { owner: "wren", now: NOW };
    await expect(rotationOf(store, "exa@main", o)).rejects.toMatchObject({ status: 501 });
    await expect(rotationOf(store, "anthropic@nope", o)).rejects.toMatchObject({ status: 404 });
    await expect(rotationOf(store, "nonsense", o)).rejects.toMatchObject({ status: 400 });
  });
});
