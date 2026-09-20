/**
 * DomainProvision under a real Restate: a run stops at the purchase gate,
 * `status` shows it, `approve` moves it on, the flow finishes; pause holds
 * the next step and play releases it; reset forgets a waiting run. Needs
 * Docker.
 */
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NeedsHuman } from "../src/browser/session.js";
import { Unrecoverable } from "../src/engine/effects.js";
import { makeRunObject, type RunObject } from "../src/engine/object.js";
import { runsRegistry } from "../src/engine/registry.js";
import {
  type CompiledCatalog,
  type CompiledWorkflow,
  compiledKey,
  makeCompiledRunObject,
} from "../src/workflows/compiled.js";
import { type DomainWorkflow, domainWorkflow } from "../src/workflows/domain/index.js";
import { workflow as exampleTitle } from "../src/workflows/example-title/index.js";
import { fakeBrowser, fakeDeps, fakeHost } from "./fakes.js";

const deps = fakeDeps();
const host = fakeHost();
/** A catalog a test can add to while Restate is up: what a compile does on disk. */
const shelf = new Map<string, CompiledWorkflow>();
const catalog: CompiledCatalog = {
  list: async () => [...shelf.values()],
  get: async (name) => shelf.get(name) ?? null,
  proofs: async () => ({}),
};
const browserCalls: string[] = [];
const browser = fakeBrowser(browserCalls);
let env: RestateTestEnvironment;
beforeAll(async () => {
  env = await RestateTestEnvironment.start({
    services: [
      runsRegistry,
      makeRunObject(domainWorkflow, deps, host),
      makeCompiledRunObject({ catalog, browser, host }),
    ],
    alwaysReplay: true,
  });
});
afterAll(async () => {
  await env?.stop();
});

const object = (domain: string) =>
  clients
    .connect({ url: env.baseUrl() })
    .objectClient<RunObject<DomainWorkflow>>({ name: "domain" }, domain);
const compiled = (workflow: string, key: string) =>
  clients
    .connect({ url: env.baseUrl() })
    .objectClient<RunObject<typeof exampleTitle>>({ name: "Compiled" }, compiledKey(workflow, key));
const registry = () =>
  clients
    .connect({ url: env.baseUrl() })
    .objectClient<typeof runsRegistry>({ name: "Runs" }, "all");

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const inbox = [{ local: "will", givenName: "W", familyName: "J" }];

describe("domain run object", () => {
  it("waits at the purchase gate, moves on approve, finishes", async () => {
    const domain = "fresh.test";
    await object(domain).run({ domain, inboxes: inbox });
    const waiting = await until(
      () => object(domain).status(),
      (s) => s.gate !== null,
    );
    expect(waiting.gate).toMatchObject({ name: "purchase", step: "buy" });
    expect(waiting.outcome).toMatchObject({ status: "waiting" });
    expect(waiting.outcome?.results.check?.status).toBe("done");
    expect(host.subjects()).toContain("fresh.test: approve purchase?");
    await expect(object(domain).run(null)).rejects.toThrow(/waiting at a gate/);

    await expect(object(domain).approve({ name: "human" })).rejects.toThrow(
      /the open gate is purchase/,
    );
    await object(domain).approve({ name: "purchase" });
    const finished = await until(
      () => object(domain).status(),
      (s) => s.outcome?.status === "done",
    );
    expect(finished.gate).toBeNull();
    expect(finished.outcome?.results.buy?.detail).toBe("bought ($10.11)");
    expect(finished.outcome?.results.loops?.status).toBe("done");
    expect(host.subjects()).toContain("fresh.test: done");
    expect(deps.calls).toContain("buy fresh.test");
    const rows = await until(
      () => registry().list(),
      (r) => r.some((x) => x.key === domain && x.status === "done"),
    );
    expect(rows.find((x) => x.key === domain)).toMatchObject({ workflow: "domain", gate: null });
    expect(
      host.events.filter((e) => e.type === "step").map((e) => (e as { step: string }).step),
    ).toContain("loops");
  });

  it("pause holds the next step; play runs on", async () => {
    const domain = "paused.test";
    // Paused before it starts: `run` queues a step that sees the flag and stops.
    await object(domain).pause();
    await object(domain).run({ domain, inboxes: inbox, buy: false });
    await new Promise((r) => setTimeout(r, 1500));
    const held = await object(domain).status();
    expect(held.paused).toBe(true);
    expect(held.outcome).toBeNull();
    await object(domain).play();
    const done = await until(
      () => object(domain).status(),
      (s) => s.outcome?.status !== undefined && s.outcome.status !== "running",
    );
    // buy=false on a free domain fails at buy: the point is that play ran the steps.
    expect(done.outcome?.results.check?.status).toBe("done");
    expect(done.outcome?.results.buy?.status).toBe("failed");
  });

  it("reset forgets a waiting run and a stale step message cannot revive it", async () => {
    const domain = "second.test";
    await object(domain).run({ domain, inboxes: inbox });
    await until(
      () => object(domain).status(),
      (s) => s.gate !== null,
    );
    await object(domain).reset();
    const s = await object(domain).status();
    expect(s).toMatchObject({ gate: null, plan: null, outcome: null, paused: false });
    await expect(object(domain).approve({ name: "purchase" })).rejects.toThrow(/no gate open/);
    await expect(object(domain).run(null)).rejects.toThrow(/no plan/);
    expect(deps.calls).not.toContain("buy second.test");
  });

  it("a transient error inside an effect is retried, and the step goes on to finish", async () => {
    const domain = "flaky.test";
    // A network blip on the first try; the runtime retries the effect and the second try passes.
    deps.failCheckWith = new Error("page.goto: net::ERR_INTERNET_DISCONNECTED");
    deps.failCheckTimes = 1;
    try {
      await object(domain).run({ domain, inboxes: inbox });
      const s = await until(
        () => object(domain).status(),
        (s) => s.gate !== null || s.outcome?.status === "failed",
        30_000,
      );
      expect(s.outcome?.status).not.toBe("failed");
      expect(s.gate?.name).toBe("purchase");
    } finally {
      deps.failCheckWith = null;
      deps.failCheckTimes = Number.POSITIVE_INFINITY;
    }
  });

  it("an unrecoverable error inside an effect fails the step at once, and NeedsHuman keeps its type", async () => {
    const domain = "noconfig.test";
    deps.failCheckWith = new Unrecoverable("CLOUDFLARE_API_TOKEN is required");
    try {
      await object(domain).run({ domain, inboxes: inbox });
      const failed = await until(
        () => object(domain).status(),
        (s) => s.outcome?.status === "failed",
        15_000,
      );
      expect(failed.outcome?.results.check).toMatchObject({
        status: "failed",
        detail: expect.stringMatching(/CLOUDFLARE_API_TOKEN is required/),
      });
    } finally {
      deps.failCheckWith = null;
    }

    const human = "handoff.test";
    const nh = new NeedsHuman("captcha on the registrar page");
    nh.artifacts = { screenshot: "/tmp/shot.png" };
    deps.failCheckWith = nh;
    try {
      await object(human).run({ domain: human, inboxes: inbox });
      const waiting = await until(
        () => object(human).status(),
        (s) => s.gate !== null,
        15_000,
      );
      expect(waiting.gate).toMatchObject({
        name: "human",
        step: "check",
        screenshot: "/tmp/shot.png",
      });
    } finally {
      deps.failCheckWith = null;
    }
  });
});

describe("Compiled object", () => {
  it("runs a flow that appeared after boot, under its own name in events and the registry", async () => {
    await expect(compiled("example-title", "k1").run({ dryRun: false })).rejects.toThrow(
      /no compiled workflow named example-title/,
    );
    shelf.set("example-title", { dir: "", workflow: exampleTitle, proof: null });
    browser.on({ name: "read-main-heading" } as never, async () => ({ title: "Example Domain" }));
    await compiled("example-title", "k1").run({ dryRun: false });
    const finished = await until(
      () => compiled("example-title", "k1").status(),
      (s) => s.outcome?.status === "done",
    );
    expect(finished).toMatchObject({ workflow: "example-title", key: "k1" });
    expect(host.subjects()).toContain("k1: done");
    const rows = await until(
      () => registry().list(),
      (r) => r.some((x) => x.workflow === "example-title" && x.key === "k1"),
    );
    expect(rows.find((x) => x.workflow === "example-title")).toMatchObject({ status: "done" });
  });
});
