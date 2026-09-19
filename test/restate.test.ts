/**
 * DomainProvision under a real Restate: a run stops at the purchase gate,
 * `status` shows it, `approve` moves it on, the flow finishes; pause holds
 * the next step and play releases it; reset forgets a waiting run. Needs
 * Docker.
 */
import * as clients from "@restatedev/restate-sdk-clients";
import { RestateTestEnvironment } from "@restatedev/restate-sdk-testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DomainProvision, makeDomainProvision } from "../src/restate/domain-provision.js";
import { fakeDeps } from "./fakes.js";

const deps = fakeDeps();
let env: RestateTestEnvironment;
beforeAll(async () => {
  env = await RestateTestEnvironment.start({
    services: [makeDomainProvision(deps)],
    alwaysReplay: true,
  });
});
afterAll(async () => {
  await env?.stop();
});

const object = (domain: string) =>
  clients
    .connect({ url: env.baseUrl() })
    .objectClient<DomainProvision>({ name: "DomainProvision" }, domain);

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

describe("DomainProvision", () => {
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
    expect(deps.notes).toContain("autobrowse fresh.test: approve purchase?");
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
    expect(deps.notes).toContain("autobrowse fresh.test: done");
    expect(deps.calls).toContain("buy fresh.test");
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
});
