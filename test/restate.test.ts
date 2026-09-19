/**
 * DomainProvision under a real Restate: a run parks at the purchase gate,
 * `status` shows it, `approve` resumes it, the flow finishes. Needs Docker.
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
const sender = (domain: string) =>
  clients
    .connect({ url: env.baseUrl() })
    .objectSendClient<DomainProvision>({ name: "DomainProvision" }, domain);

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("DomainProvision", () => {
  it("parks at the purchase gate, resumes on approve, finishes", async () => {
    const domain = "fresh.test";
    await sender(domain).run({
      domain,
      inboxes: [{ local: "will", givenName: "W", familyName: "J" }],
    });
    const parked = await until(
      () => object(domain).status(),
      (s) => s.gate !== null,
    );
    expect(parked.gate?.name).toBe("purchase");
    expect(parked.outcome?.results.check?.status).toBe("done");
    expect(deps.notes).toContain("provision fresh.test: approve purchase?");

    await expect(object(domain).approve({ name: "wrong" })).rejects.toThrow(
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
    expect(deps.notes).toContain("provision fresh.test: done");
    expect(deps.calls).toContain("buy fresh.test");
  });

  it("cancel ends a parked run and it forgets itself; reset clears a finished one", async () => {
    const domain = "second.test";
    await sender(domain).run({
      domain,
      inboxes: [{ local: "a", givenName: "A", familyName: "B" }],
    });
    await until(
      () => object(domain).status(),
      (s) => s.gate !== null,
    );
    expect(await object(domain).cancel({ note: "changed my mind" })).toBe(true);
    const s = await until(
      () => object(domain).status(),
      (x) => x.gate === null,
    );
    expect(s.outcome).toBeNull();
    expect(s.plan).toBeNull();
    expect(await object(domain).cancel(null)).toBe(false);
    await object(domain).reset();
    await expect(object(domain).approve({ name: "purchase" })).rejects.toThrow(/no gate open/);
    expect(deps.calls).not.toContain("buy second.test");
  });
});
