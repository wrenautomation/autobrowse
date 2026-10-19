import { applyProjection, keyId, memoryEnvStore, memoryKeys } from "credvault";
import { describe, expect, it } from "vitest";
import type { KeyKeeper } from "../../deps/keys.js";
import { memoryEffects, runFlow } from "../../index.js";
import { createKeyFlow, keyWorks, planSchema, workflow } from "./index.js";

const OWNER = "wren";
const NEW = "sk-ant-api03-synthetic-new-key-0000000000";
const OLD = "sk-ant-api03-synthetic-old-key-1111111111";
const NOW = Date.parse("2026-10-19T10:00:00Z");

/** A memory keeper: the vault, an env store the projection writes, and the login it signs in with. */
function keeper(init: { secret: string; extra?: object }[] = []) {
  const store = memoryKeys(
    init.map(({ secret, extra }) => ({
      site: "anthropic",
      account: "prod",
      owner: OWNER,
      secret,
      purposes: ["default", "drafts"],
      status: "live" as const,
      madeAt: "2026-09-01T00:00:00.000Z",
      via: "anthropic@william",
      vendorId: "prod-old",
      cap: { amount: 100, unit: "calls" as const },
      ...extra,
    })),
  );
  const env = memoryEnvStore();
  const keys: KeyKeeper = {
    owner: OWNER,
    put: (k) => store.put(k),
    get: (a) => store.get(a),
    project: async (vendors) => {
      const all = await Promise.all((await store.list()).map((i) => store.get(i.address)));
      return applyProjection(
        env,
        all.flatMap((k) => (k ? [k] : [])),
        { vendors },
      );
    },
    login: async (site) => site,
  };
  return { store, env, keys };
}

/** A page that shows `shown` on the dialog and records the flows it ran. */
function browser(shown: string, ran: string[] = []) {
  return {
    run: async (
      flow: { site: string; run: (fp: never, input: never) => Promise<unknown> },
      input: never,
    ) => {
      ran.push(flow.site);
      const fp = {
        open: async () => undefined,
        act: async () => undefined,
        read: async () => `Save your key now: ${shown}`,
      };
      return flow.run(fp as never, input);
    },
  } as never;
}

const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
const refused = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
const approve = () => ({ approved: true, note: null, at: "2026-10-19T10:00:00Z" });

/** All the stored names, never values. */
const names = async (env: ReturnType<typeof memoryEnvStore>) =>
  (await env.list()).map((e) => e.name).sort();

describe("anthropic-console-api-key", () => {
  it("parses the plan: account defaults to name and must be a key label", () => {
    expect(planSchema.parse({ name: "autobrowse-prod" })).toMatchObject({
      dryRun: false,
      purposes: [],
    });
    expect(planSchema.safeParse({ name: "Has Space" }).success).toBe(false);
    expect(planSchema.safeParse({ name: "Has Space", account: "prod" }).success).toBe(true);
    expect(planSchema.safeParse({ name: "x", replaces: "not an address" }).success).toBe(false);
    expect(planSchema.safeParse({ name: "x", replaces: "anthropic@prod" }).success).toBe(true);
    // keepAs is gone: an unknown key is ignored, not kept anywhere.
    expect(planSchema.parse({ name: "x", keepAs: "FOO" })).not.toHaveProperty("keepAs");
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const { keys } = keeper();
    const plan = planSchema.parse({ dryRun: true, name: "autobrowse-prod" });
    const out = await runFlow(memoryEffects().fx, workflow, { browser: browser(NEW), keys }, plan);
    expect(out.status).toBe("planned");
    expect(out.results["check-key"]?.status).toBe("done");
    expect(out.results["create-key"]?.status).toBe("planned");
  });

  it("proves a key with a free models list, header not URL", async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push([url, init]);
      return new Response("{}", { status: url.includes("?") && seen.length === 1 ? 200 : 401 });
    }) as typeof fetch;
    expect(await keyWorks("sk-ant-api03-test", f)).toBe(true);
    expect(await keyWorks("sk-ant-api03-test", f)).toBe(false);
    expect(seen[0]?.[0]).not.toContain("sk-ant");
    expect(seen[0]?.[1]?.headers).toMatchObject({ "x-api-key": "sk-ant-api03-test" });
  });

  it("asks before it makes a key", async () => {
    const { keys, store } = keeper();
    const plan = planSchema.parse({ name: "prod" });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      { browser: browser(NEW), keys, fetch: ok },
      plan,
    );
    expect(out.status).toBe("waiting");
    expect(await store.list()).toEqual([]);
  });

  it("keeps a new key as anthropic@<account> and projects the env names", async () => {
    const { keys, store, env } = keeper();
    const ran: string[] = [];
    const plan = planSchema.parse({ name: "prod", purposes: ["default"] });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      { browser: browser(NEW, ran), keys, fetch: ok },
      plan,
      approve,
    );
    expect(out.status).toBe("done");
    expect(ran).toEqual(["anthropic"]);
    const kept = await store.get("anthropic@prod");
    expect(kept).toMatchObject({
      site: "anthropic",
      account: "prod",
      owner: OWNER,
      secret: NEW,
      via: "anthropic",
      vendorId: "prod",
      purposes: ["default"],
    });
    expect(await env.get("ANTHROPIC_API_KEY")).toBe(NEW);
    const detail = out.results["create-key"]?.detail ?? "";
    expect(detail).toContain("anthropic@prod");
    expect(detail).toContain(keyId(NEW));
    expect(detail).toContain("ANTHROPIC_API_KEY");
    // The value is in the vault and the env, never in a journaled result.
    expect(JSON.stringify(out)).not.toContain(NEW);
  });

  it("signs in under the named login and records it as via", async () => {
    const { keys, store } = keeper();
    const ran: string[] = [];
    const plan = planSchema.parse({ name: "prod", login: "anthropic@william" });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      { browser: browser(NEW, ran), keys, fetch: ok },
      plan,
      approve,
    );
    expect(out.status).toBe("done");
    expect(ran).toEqual(["anthropic@william"]);
    expect((await store.get("anthropic@prod"))?.via).toBe("anthropic@william");
  });

  it("a refused proof keeps nothing", async () => {
    const { keys, store, env } = keeper();
    const plan = planSchema.parse({ name: "prod" });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      { browser: browser(NEW), keys, fetch: refused },
      plan,
      approve,
    );
    expect(out.status).toBe("failed");
    expect(await store.list()).toEqual([]);
    expect(await names(env)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(NEW);
  });

  it("a new key at a taken address stops before the browser", async () => {
    const { keys } = keeper([{ secret: OLD }]);
    const ran: string[] = [];
    const plan = planSchema.parse({ name: "prod" });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      { browser: browser(NEW, ran), keys, fetch: ok },
      plan,
      approve,
    );
    expect(out.status).toBe("failed");
    expect(out.results["check-key"]?.detail).toContain("already a key");
    expect(ran).toEqual([]);
  });

  it("rotates: same address, the old key's purposes, via and cap, the old id in previous", async () => {
    const { keys, store, env } = keeper([{ secret: OLD }]);
    await keys.project(["anthropic"]);
    expect(await env.get("ANTHROPIC_API_KEY")).toBe(OLD);
    const plan = planSchema.parse({
      name: "prod-20261019",
      account: "prod",
      replaces: "anthropic@prod",
      login: "anthropic@william",
    });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      { browser: browser(NEW), keys, fetch: ok },
      plan,
      approve,
    );
    expect(out.status).toBe("done");
    const rotated = await store.get("anthropic@prod");
    expect(rotated).toMatchObject({
      secret: NEW,
      purposes: ["default", "drafts"],
      via: "anthropic@william",
      cap: { amount: 100, unit: "calls" },
      vendorId: "prod-20261019",
    });
    expect(rotated?.previous).toEqual([
      { id: keyId(OLD), vendorId: "prod-old", revokedAt: expect.any(String) },
    ]);
    expect(await store.list()).toHaveLength(1);
    expect(await env.get("ANTHROPIC_API_KEY")).toBe(NEW);
    const detail = out.results["create-key"]?.detail ?? "";
    expect(detail).toContain(
      'revoke "prod-old" at https://platform.claude.com/settings/workspaces/default/keys by hand',
    );
    expect(JSON.stringify(out)).not.toContain(NEW);
    expect(JSON.stringify(out)).not.toContain(OLD);
  });

  it("a rotation of a missing, other-vendor or other-owner key stops before the browser", async () => {
    const other = keeper([{ secret: OLD, extra: { site: "exa", account: "prod" } }]);
    const foreign = keeper([{ secret: OLD, extra: { owner: "someone" } }]);
    for (const [keys, replaces, why] of [
      [other.keys, "anthropic@prod", "no key"],
      [other.keys, "exa@prod", "not a anthropic key"],
      [foreign.keys, "anthropic@prod", "no key"],
    ] as const) {
      const ran: string[] = [];
      const plan = planSchema.parse({ name: "prod-2", account: "prod", replaces });
      const out = await runFlow(
        memoryEffects().fx,
        workflow,
        { browser: browser(NEW, ran), keys, fetch: ok },
        plan,
        approve,
      );
      expect(out.status).toBe("failed");
      expect(out.results["check-key"]?.detail).toContain(why);
      expect(ran).toEqual([]);
    }
  });

  it("the flow alone returns names and ids, no value", async () => {
    const { keys } = keeper();
    const result = await createKeyFlow.run(
      { open: async () => undefined, act: async () => undefined, read: async () => NEW } as never,
      {
        name: "prod",
        account: "prod",
        purposes: [],
        via: "anthropic",
        keys,
        fetch: ok,
        now: () => NOW,
      },
    );
    expect(result).toMatchObject({ address: "anthropic@prod", id: keyId(NEW), vendorId: "prod" });
    expect(JSON.stringify(result)).not.toContain(NEW);
  });

  it("a failed projection does not fail the flow (a retry would mint again)", async () => {
    const { keys, store } = keeper();
    const failing: KeyKeeper = { ...keys, project: () => Promise.reject(new Error("ssm down")) };
    const plan = planSchema.parse({ name: "prod" });
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      { browser: browser(NEW), keys: failing, fetch: ok },
      plan,
      approve,
    );
    expect(out.status).toBe("done");
    expect(out.results["create-key"]?.detail).toContain("creds key project");
    expect((await store.get("anthropic@prod"))?.secret).toBe(NEW);
  });
});
