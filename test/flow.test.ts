import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/flow/plan.js";
import { RESULTS, runFlow, STEPS } from "../src/flow/steps.js";
import { fakeCloudflare, fakeDeps, fakeEffects, NeedsHuman } from "./fakes.js";

const plan = (over: Record<string, unknown> = {}) =>
  parsePlan({
    domain: "wren-new.test",
    inboxes: [
      { local: "will", givenName: "William", familyName: "Jin" },
      { local: "hello", givenName: "William", familyName: "Jin" },
    ],
    signatureHtml: "<b>W</b>",
    ...over,
  });

describe("runFlow", () => {
  it("provisions a free domain end to end after the purchase is approved", async () => {
    const deps = fakeDeps();
    const { fx, gates } = fakeEffects({ purchase: [{ approved: true, note: null }] });
    const out = await runFlow(fx, deps, plan());
    expect(out.status).toBe("done");
    expect(gates).toEqual(["purchase"]);
    expect(Object.keys(out.results)).toEqual([...STEPS]);
    expect(out.results.buy?.detail).toBe("bought ($10.11)");
    expect(deps.calls).toEqual([
      "buy wren-new.test",
      "addDomain wren-new.test",
      "verify wren-new.test",
      "dkimGenerate",
      "dkimStart",
      "createUser will@wren-new.test",
      "secret /provision/inboxes/will@wren-new.test/password",
      "createUser hello@wren-new.test",
      "secret /provision/inboxes/hello@wren-new.test/password",
      "signature will@wren-new.test",
      "signature hello@wren-new.test",
      "warmup will@wren-new.test",
      "warmup hello@wren-new.test",
      "roster write",
      "redeploy",
      "loops will@wren-new.test",
      "loops hello@wren-new.test",
    ]);
    const dns = deps.cloudflare.records.map((r) => `${r.type} ${r.name} ${r.content}`);
    expect(dns).toEqual([
      "TXT @ google-site-verification=tok",
      "MX @ smtp.google.com",
      "TXT @ v=spf1 include:_spf.google.com ~all",
      "TXT _dmarc v=DMARC1; p=none; rua=mailto:dmarc@fleet.test",
      "TXT google._domainkey v=DKIM1; k=rsa; p=abc",
    ]);
    expect(deps.rosterText()).toContain('address = "will@wren-new.test"');
    expect(deps.rosterText()).toContain('address = "old@fleet.test"');
    expect(JSON.stringify(out.memo)).not.toMatch(/password/);
    expect(deps.notes).toEqual([]);
  });

  it("skips the purchase for an owned domain and never opens a gate", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    const { fx, gates } = fakeEffects();
    const out = await runFlow(fx, deps, plan());
    expect(out.status).toBe("done");
    expect(gates).toEqual([]);
    expect(out.results.buy?.status).toBe("skipped");
    expect(out.results.zone?.detail).toBe("zone z1");
  });

  it("stops as rejected when the purchase is declined", async () => {
    const deps = fakeDeps();
    const { fx } = fakeEffects({ purchase: [{ approved: false, note: "too pricey" }] });
    const out = await runFlow(fx, deps, plan());
    expect(out.status).toBe("rejected");
    expect(out.results.buy).toMatchObject({ status: "rejected", detail: "too pricey" });
    expect(deps.calls).toEqual([]);
  });

  it("refuses a domain someone else holds", async () => {
    const deps = fakeDeps({ availability: async () => "taken" });
    const { fx } = fakeEffects();
    const out = await runFlow(fx, deps, plan());
    expect(out.status).toBe("failed");
    expect(out.results.check?.detail).toContain("registered by someone else");
  });

  it("dry run plans up to the first irreversible step", async () => {
    const deps = fakeDeps();
    const { fx } = fakeEffects();
    const out = await runFlow(fx, deps, plan({ dryRun: true }));
    expect(out.status).toBe("planned");
    expect(out.results.check?.status).toBe("done");
    expect(out.results.buy?.status).toBe("planned");
    expect(deps.calls).toEqual([]);
  });

  it("parks at a human gate when a browser flow needs one, then retries the step", async () => {
    let attempts = 0;
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    deps.browser.dkimGenerate = async () => {
      attempts += 1;
      if (attempts === 1) throw new NeedsHuman("google admin: login page", "/shots/x.png");
      return { name: "google._domainkey", value: "v=DKIM1; p=z" };
    };
    const { fx, gates } = fakeEffects({ human: [{ approved: true, note: null }] });
    const out = await runFlow(fx, deps, plan());
    expect(out.status).toBe("done");
    expect(gates).toEqual(["human"]);
    expect(attempts).toBe(2);
    expect(deps.notes).toEqual(["provision wren-new.test: needs you at dkim-generate"]);
    expect(out.results["dkim-generate"]?.status).toBe("done");
  });

  it("resumes after a failure without redoing finished steps", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    let fail = true;
    const realCreate = deps.google.createUser;
    deps.google.createUser = async (u) => {
      if (fail) throw new Error("quota");
      return realCreate(u);
    };
    const { fx, state } = fakeEffects();
    const first = await runFlow(fx, deps, plan());
    expect(first.status).toBe("failed");
    expect(first.results.inboxes).toMatchObject({ status: "failed", detail: "Error: quota" });
    const before = deps.calls.length;
    fail = false;
    const second = await runFlow(fx, deps, plan());
    expect(second.status).toBe("done");
    const after = deps.calls.slice(before);
    expect(after.filter((c) => c === "dkimGenerate")).toEqual([]);
    expect(after[0]).toBe("createUser will@wren-new.test");
    expect(second.results.inboxes?.detail).toBe(
      "will@wren-new.test created, hello@wren-new.test created",
    );
    expect((state.get(RESULTS) as Record<string, { status: string }>).inboxes.status).toBe("done");
  });

  it("honours no-handoff and no-warmup", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    const { fx } = fakeEffects();
    const out = await runFlow(fx, deps, plan({ warmup: false, handoff: false }));
    expect(out.status).toBe("done");
    expect(out.results.warmup?.status).toBe("skipped");
    expect(out.results.roster?.status).toBe("skipped");
    expect(out.results.loops?.status).toBe("skipped");
    expect(
      deps.calls.some(
        (c) => c.startsWith("warmup") || c.startsWith("loops") || c === "roster write",
      ),
    ).toBe(false);
  });
});

describe("parsePlan", () => {
  it("rejects a bad domain or inbox", () => {
    expect(() =>
      parsePlan({
        domain: "not a domain",
        inboxes: [{ local: "a", givenName: "A", familyName: "B" }],
      }),
    ).toThrow();
    expect(() => parsePlan({ domain: "ok.test", inboxes: [] })).toThrow();
    expect(() =>
      parsePlan({
        domain: "ok.test",
        inboxes: [{ local: "Bad Local", givenName: "A", familyName: "B" }],
      }),
    ).toThrow();
  });
});
