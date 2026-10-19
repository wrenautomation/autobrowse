import { applyProjection, keyId, memoryEnvStore, memoryKeys, type SecretUse } from "credvault";
import { describe, expect, it } from "vitest";
import { ownerKeysIn } from "../src/reach/key-source.js";
import type { SiteFacade } from "../src/sites/facade.js";
import { keyAdmin } from "../src/sites/keys.js";
import { sitesService } from "../src/sites/service.js";

const NOW = Date.UTC(2026, 9, 19, 12);
const SECRETS = ["synthetic-main", "synthetic-bulk", "synthetic-exa", "synthetic-theirs"];

const key = (extra: object) => ({
  site: "anthropic",
  account: "prod",
  owner: "wren",
  secret: "synthetic-main",
  purposes: ["default"],
  status: "live" as const,
  madeAt: "2026-09-01T00:00:00.000Z",
  ...extra,
});

function setup(start: object[] = []) {
  const store = memoryKeys([
    key({ via: "anthropic@william", vendorId: "prod-1" }),
    key({ account: "bulk", secret: "synthetic-bulk", purposes: [] }),
    key({ site: "exa", account: "main", secret: "synthetic-exa" }),
    key({ account: "gone", secret: "synthetic-gone", purposes: [], status: "revoked" }),
    key({ account: "theirs", owner: "someone", secret: "synthetic-theirs" }),
    ...start.map((k) => key(k)),
  ]);
  const env = memoryEnvStore();
  const uses: SecretUse[] = [];
  const projected: string[][] = [];
  const admin = keyAdmin({
    store,
    audit: { record: async (u) => void uses.push(u), recent: async () => uses },
    project: async (vendors) => {
      projected.push(vendors);
      return applyProjection(env, await ownerKeysIn(store, "wren"), { vendors });
    },
    owner: "wren",
    now: () => NOW,
  });
  const sent: { service: string; key: string; plan: unknown; opts: unknown }[] = [];
  const steps: { name: string; attempts: number | undefined }[] = [];
  const ctx = {
    request: () => ({ id: "inv_1", headers: new Map() }),
    run: async <T>(name: string, fn: () => Promise<T>, o?: { maxRetryAttempts?: number }) => {
      steps.push({ name, attempts: o?.maxRetryAttempts });
      return fn();
    },
    objectSendClient: (service: { name: string }, k: string) => ({
      run: (plan: unknown, opts: unknown) =>
        void sent.push({ service: service.name, key: k, plan, opts }),
    }),
  };
  const facade = { list: async () => [] } as unknown as SiteFacade;
  const h = (
    sitesService(facade, undefined, undefined, undefined, { keys: admin }) as unknown as {
      service: Record<string, (...a: never) => Promise<unknown>>;
    }
  ).service;
  return { store, env, uses, projected, admin, sent, steps, ctx: ctx as never, h };
}

const failsWith = (p: Promise<unknown>, code: number) =>
  p.then(
    () => {
      throw new Error("did not fail");
    },
    (e: { code?: number }) => expect(e.code).toBe(code),
  );

describe("keys handlers", () => {
  it("keys lists the owner's keys with no value in the answer; revoked ones only with all", async () => {
    const t = setup();
    t.uses.push({
      at: "2026-10-18T10:00:00.000Z",
      credential: "anthropic@prod",
      keyId: keyId("synthetic-main"),
      allowed: true,
      by: "x",
      url: "r",
    } as SecretUse);
    const out = (await t.h.keys?.(t.ctx, {})) as { keys: { address: string; uses: number }[] };
    expect(out.keys.map((k) => k.address).sort()).toEqual([
      "anthropic@bulk",
      "anthropic@prod",
      "exa@main",
    ]);
    const raw = JSON.stringify(out);
    for (const s of SECRETS) expect(raw).not.toContain(s);
    expect(raw).not.toContain('"secret"');
    const prod = out.keys.find((k) => k.address === "anthropic@prod");
    expect(prod).toMatchObject({
      id: keyId("synthetic-main"),
      uses: 1,
      lastUsedAt: "2026-10-18T10:00:00.000Z",
      via: "anthropic@william",
      vendorId: "prod-1",
    });
    expect(out.keys.find((k) => k.address === "anthropic@bulk")).toMatchObject({
      uses: 0,
      lastUsedAt: null,
    });
    const one = (await t.h.keys?.(t.ctx, { vendor: "exa" })) as { keys: unknown[] };
    expect(one.keys).toHaveLength(1);
    const all = (await t.h.keys?.(t.ctx, { all: true })) as { keys: { address: string }[] };
    expect(all.keys.map((k) => k.address)).toContain("anthropic@gone");
    expect(all.keys.map((k) => k.address)).not.toContain("anthropic@theirs");
  });

  it("reads retry, writes run once, each in one step", async () => {
    const t = setup();
    await t.h.keys?.(t.ctx, {});
    await t.h.keySpend?.(t.ctx, { address: "anthropic@prod" });
    await t.h.keyRevoke?.(t.ctx, { address: "anthropic@bulk" });
    expect(t.steps.map((s) => [s.name, s.attempts])).toEqual([
      ["sites keys", 300],
      ["sites keySpend", 1],
      ["sites keyRevoke", 1],
    ]);
  });

  it("keySpend marks the key spent until the 1st of next month, or a date, and re-projects", async () => {
    const t = setup();
    const row = (await t.h.keySpend?.(t.ctx, { address: "anthropic@prod" })) as {
      status: string;
      spentUntil: string;
    };
    expect(row).toMatchObject({ status: "spent", spentUntil: "2026-11-01T00:00:00.000Z" });
    expect(JSON.stringify(row)).not.toContain("synthetic-");
    expect(t.projected).toEqual([["anthropic"]]);
    const dated = (await t.h.keySpend?.(t.ctx, {
      address: "anthropic@bulk",
      until: "2026-12-05",
    })) as { spentUntil: string };
    expect(dated.spentUntil).toBe("2026-12-05T00:00:00.000Z");
    await failsWith(
      t.h.keySpend?.(t.ctx, { address: "anthropic@bulk", until: "not a date" }) as Promise<unknown>,
      400,
    );
  });

  it("keyRevoke revokes here and re-projects: the env names drop the key", async () => {
    // Start from a projection that holds the keys.
    const fresh = setup();
    await applyProjection(fresh.env, await ownerKeysIn(fresh.store, "wren"), {
      vendors: ["anthropic"],
    });
    expect(Object.values(fresh.env.values)).toContain("synthetic-main");
    const out = (await fresh.h.keyRevoke?.(fresh.ctx, { address: "anthropic@prod" })) as {
      key: { status: string; revokedAt: string };
      projected: { put: string[]; removed: string[] };
    };
    expect(out.key).toMatchObject({ status: "revoked", revokedAt: new Date(NOW).toISOString() });
    expect(out.projected.put.length + out.projected.removed.length).toBeGreaterThan(0);
    expect(Object.values(fresh.env.values)).not.toContain("synthetic-main");
    expect(JSON.stringify(out)).not.toContain("synthetic-");
    expect(fresh.projected).toEqual([["anthropic"]]);
  });

  it("an unknown address is 404, a bad one 400, another owner's key 404", async () => {
    const t = setup();
    for (const handler of ["keySpend", "keyRevoke", "keyRotate"] as const) {
      await failsWith(
        t.h[handler]?.(t.ctx, { address: "anthropic@nope" }) as Promise<unknown>,
        404,
      );
      await failsWith(
        t.h[handler]?.(t.ctx, { address: "anthropic@theirs" }) as Promise<unknown>,
        404,
      );
      await failsWith(
        t.h[handler]?.(t.ctx, { address: "not an address" }) as Promise<unknown>,
        400,
      );
      await failsWith(t.h[handler]?.(t.ctx, {}) as Promise<unknown>, 400);
    }
    await failsWith(t.h.keys?.(t.ctx, { all: "yes" }) as Promise<unknown>, 400);
    expect(t.sent).toEqual([]);
  });

  it("keyRotate on a vendor with no flow is 501 and starts nothing", async () => {
    const t = setup();
    await failsWith(t.h.keyRotate?.(t.ctx, { address: "exa@main" }) as Promise<unknown>, 501);
    expect(t.sent).toEqual([]);
  });

  it("keyRotate starts the vendor's run on the owner's Compiled object and answers the run", async () => {
    const t = setup();
    const out = await t.h.keyRotate?.(t.ctx, { address: "anthropic@prod" });
    expect(out).toEqual({
      run: "anthropic-console-api-key/rotate-prod-20261019",
      workflow: "anthropic-console-api-key",
    });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({
      key: "anthropic-console-api-key/rotate-prod-20261019",
      plan: {
        name: "prod-20261019",
        account: "prod",
        replaces: "anthropic@prod",
        login: "anthropic@william",
        dryRun: false,
      },
    });
    expect(t.sent[0]?.service).toMatch(/^Compiled/);
    // The key is the same day's run: Restate joins a repeat to the first.
    expect(t.sent[0]?.opts).toMatchObject({
      opts: { idempotencyKey: "anthropic-console-api-key/rotate-prod-20261019" },
    });
    expect(JSON.stringify(t.sent)).not.toContain("synthetic-");
  });

  it("without a key admin every key handler is 501", async () => {
    const h = (
      sitesService({ list: async () => [] } as unknown as SiteFacade) as unknown as {
        service: Record<string, (...a: never) => Promise<unknown>>;
      }
    ).service;
    const { ctx } = setup();
    await failsWith(h.keys?.(ctx, {}) as Promise<unknown>, 501);
    await failsWith(h.keyRotate?.(ctx, { address: "anthropic@prod" }) as Promise<unknown>, 501);
  });
});
