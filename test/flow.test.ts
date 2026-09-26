import { describe, expect, it } from "vitest";
import { googleDkimGenerate } from "../src/browser/flows/google-dkim.js";
import { KEYS, nextStep, runFlow as run } from "../src/engine/run.js";
import { domainWorkflow, parseInboxSpec, parsePlan } from "../src/workflows/domain/index.js";
import { fakeCloudflare, fakeDeps, fakeEffects, NeedsHuman, scriptedAnswers } from "./fakes.js";

const STEPS = domainWorkflow.steps.map((s) => s.name);
const runFlow = (
  fx: ReturnType<typeof fakeEffects>["fx"],
  deps: ReturnType<typeof fakeDeps>,
  plan: ReturnType<typeof parsePlan>,
  answer?: Parameters<typeof run>[4],
) => run(fx, domainWorkflow, deps, plan, answer);

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
    const { fx } = fakeEffects();
    const { answer, asked } = scriptedAnswers({ purchase: [{}] });
    const out = await runFlow(fx, deps, plan(), answer);
    expect(out.status).toBe("done");
    expect(asked).toEqual(["purchase"]);
    expect(Object.keys(out.results)).toEqual([...STEPS]);
    expect(out.results.buy?.detail).toBe("bought for $10.44");
    expect(deps.calls).toEqual([
      "buy wren-new.test",
      "addDomain wren-new.test",
      "verify wren-new.test",
      "dkimGenerate",
      "dkimStart",
      "createUser will@wren-new.test",
      "credential google@will@wren-new.test",
      "createUser hello@wren-new.test",
      "credential google@hello@wren-new.test",
      "signature will@wren-new.test",
      "signature hello@wren-new.test",
      "authenticator",
      "authenticator",
      "consent will@wren-new.test",
      "warmup will@wren-new.test",
      "consent hello@wren-new.test",
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
  });

  it("skips the purchase for an owned domain and never opens a gate", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    const { fx } = fakeEffects();
    const { answer, asked } = scriptedAnswers({});
    const out = await runFlow(fx, deps, plan(), answer);
    expect(out.status).toBe("done");
    expect(asked).toEqual([]);
    expect(out.results.buy?.status).toBe("skipped");
    expect(out.results.zone?.detail).toBe("zone z1");
  });

  it("stops as rejected when the purchase is declined", async () => {
    const deps = fakeDeps();
    const { fx } = fakeEffects();
    const { answer } = scriptedAnswers({ purchase: [{ approved: false, note: "too pricey" }] });
    const out = await runFlow(fx, deps, plan(), answer);
    expect(out.status).toBe("rejected");
    expect(out.results.buy).toMatchObject({ status: "rejected", detail: "too pricey" });
    expect(deps.calls).toEqual([]);
  });

  it("refuses a domain someone else holds", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ unavailable: "domain_unavailable" }) });
    const { fx } = fakeEffects();
    const out = await runFlow(fx, deps, plan());
    expect(out.status).toBe("failed");
    expect(out.results.check?.detail).toContain("registered by someone else");
  });

  it("a taken domain waits for a pick among free look-alikes, then buys that one", async () => {
    const cloudflare = fakeCloudflare({ taken: ["wren-new.test"] });
    const deps = fakeDeps({ cloudflare });
    const { fx } = fakeEffects();
    const { answer, asked } = scriptedAnswers({ choose: [{ note: "2" }], purchase: [{}] });
    const out = await runFlow(fx, deps, plan({ inboxes: [] }), answer);
    expect(asked).toEqual(["choose", "purchase"]);
    expect(out.status).toBe("done");
    expect(out.results.check?.detail).toMatch(/taken; \d+ free look-alikes/);
    const picked = out.results.pick?.detail.replace("picked ", "") ?? "";
    expect(picked).not.toBe("wren-new.test");
    expect(cloudflare.purchases).toEqual([picked]);
    expect(cloudflare.created).toEqual([picked]);
    // No inboxes: a site, not a sender. Nothing after the zone ran (no browser, no Workspace).
    expect(out.results.inboxes).toMatchObject({ status: "skipped" });
    expect(deps.calls).toEqual([]);
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

  it("waits at a human gate when a browser flow needs one, then retries the step", async () => {
    let attempts = 0;
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    deps.browser.on(googleDkimGenerate, async () => {
      attempts += 1;
      deps.calls.push("dkimGenerate");
      if (attempts === 1) {
        const err = new NeedsHuman("google admin: login page");
        err.artifacts = { screenshot: "/shots/x.png", trace: "/shots/x.zip" };
        throw err;
      }
      return { name: "google._domainkey", value: "v=DKIM1; p=z" };
    });
    const { fx, state } = fakeEffects();
    // First: nobody answers, so the flow stops waiting with the artifacts on the gate.
    const waiting = await runFlow(fx, deps, plan());
    expect(waiting.status).toBe("waiting");
    expect(waiting.results["dkim-generate"]).toMatchObject({
      status: "needs-human",
      screenshot: "/shots/x.png",
      trace: "/shots/x.zip",
    });
    expect(state.get(KEYS.gate)).toMatchObject({ name: "human", step: "dkim-generate" });
    // Then the person does the thing and approves: the step reruns, nothing before it does.
    const { answer, asked } = scriptedAnswers({ human: [{}] });
    const before = deps.calls.length;
    const out = await runFlow(fx, deps, plan(), answer);
    expect(out.status).toBe("done");
    expect(asked).toEqual(["human"]);
    expect(attempts).toBe(2);
    expect(deps.calls.slice(before)[0]).toBe("dkimGenerate");
    expect(out.results["dkim-generate"]?.status).toBe("done");
    expect(state.get(KEYS.gate)).toBeUndefined();
  });

  it("a human gate can also be rejected", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    deps.browser.on(googleDkimGenerate, async () => {
      throw new NeedsHuman("nope");
    });
    const { fx } = fakeEffects();
    const { answer } = scriptedAnswers({ human: [{ approved: false, note: "later" }] });
    const out = await runFlow(fx, deps, plan(), answer);
    expect(out.status).toBe("rejected");
    expect(out.results["dkim-generate"]).toMatchObject({ status: "rejected", detail: "later" });
  });

  it("a registration that does not succeed asks a person, and a rerun never buys twice", async () => {
    const cf = fakeCloudflare({ registers: "action_required" });
    const deps = fakeDeps({ cloudflare: cf });
    const { fx } = fakeEffects();
    const { answer } = scriptedAnswers({ purchase: [{}] });
    const out = await runFlow(fx, deps, plan(), answer);
    expect(out.status).toBe("waiting");
    expect(out.results.buy?.detail).toMatch(/action_required/);
    const again = await runFlow(fx, deps, plan(), scriptedAnswers({ human: [{}] }).answer);
    expect(again.status).toBe("waiting");
    expect(cf.purchases).toEqual(["wren-new.test"]);
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
    expect((state.get(KEYS.results) as Record<string, { status: string }>).inboxes.status).toBe(
      "done",
    );
  });

  it("warmup without an Instantly key asks a person; an inbox already warming is left alone", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    const instantly = await deps.instantly();
    deps.instantly = async () => null;
    const { fx } = fakeEffects();
    const first = await runFlow(fx, deps, plan());
    expect(first.status).toBe("waiting");
    expect(first.results.warmup?.detail).toMatch(/INSTANTLY_API_KEY/);
    deps.instantly = async () => instantly;
    instantly?.accounts.set("will@wren-new.test", {
      email: "will@wren-new.test",
      status: 1,
      warmupStatus: 1,
    });
    const before = deps.calls.length;
    const second = await runFlow(fx, deps, plan(), scriptedAnswers({ human: [{}] }).answer);
    expect(second.status).toBe("done");
    expect(second.results.warmup?.detail).toBe(
      "will@wren-new.test already warming, hello@wren-new.test connected, warming",
    );
    expect(deps.calls.slice(before).filter((c) => c.startsWith("consent"))).toEqual([
      "consent hello@wren-new.test",
    ]);
  });

  it("puts the plan's picture on each inbox, in the inbox's own profile", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    const sites: string[] = [];
    const run = deps.browser.run.bind(deps.browser);
    deps.browser.run = async (flow, input) => {
      sites.push(`${flow.site}/${flow.name}`);
      return run(flow, input);
    };
    const { fx } = fakeEffects();
    const out = await runFlow(fx, deps, plan({ photoUrl: "https://x.test/brand/pfp.gif" }));
    expect(out.status).toBe("done");
    expect(deps.calls.filter((c) => c.startsWith("photo"))).toEqual([
      "photo /tmp/pfp.gif",
      "photo /tmp/pfp.gif",
    ]);
    expect(sites).toContain("google@hello@wren-new.test/profile-photo");
  });

  it("a password reset keeps the inbox's authenticator and skips enrolling it again", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    await deps.google.createUser({
      primaryEmail: "will@wren-new.test",
      givenName: "W",
      familyName: "J",
      password: "old",
    });
    await deps.credentials.put("google@will@wren-new.test", {
      username: "will@wren-new.test",
      password: "old",
      totpSecret: "JBSWY3DPEHPK3PXP",
    });
    const { fx } = fakeEffects();
    const out = await runFlow(fx, deps, plan(), scriptedAnswers({ password: [{}] }).answer);
    expect(out.status).toBe("done");
    const cred = await deps.credentials.get("google@will@wren-new.test");
    expect(cred).toMatchObject({ totpSecret: "JBSWY3DPEHPK3PXP", previousPassword: "old" });
    expect(cred?.password).not.toBe("old");
    expect(out.results.authenticator?.detail).toBe(
      "will@wren-new.test already, hello@wren-new.test TOTP enrolled",
    );
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

describe("nextStep", () => {
  it("skips done and skipped, retries needs-human, stops at a verdict", () => {
    const r = (status: string) => ({ status: status as never, detail: "", at: "" });
    const next = (results: Record<string, ReturnType<typeof r>>) =>
      nextStep(domainWorkflow, results);
    expect(next({})).toBe("check");
    expect(next({ check: r("done"), pick: r("skipped"), buy: r("skipped") })).toBe("zone");
    expect(next({ check: r("done"), pick: r("skipped"), buy: r("needs-human") })).toBe("buy");
    expect(next({ check: r("done"), pick: r("skipped"), buy: r("rejected") })).toBeNull();
    expect(next({ check: r("done"), pick: r("skipped"), buy: r("failed") })).toBe("buy");
    expect(next({ check: r("done"), pick: r("skipped"), buy: r("planned") })).toBe("buy");
    const all = Object.fromEntries(STEPS.map((s) => [s, r("done")]));
    expect(next(all)).toBeNull();
  });
});

describe("parseInboxSpec", () => {
  it("splits local:Given:Family and rejects anything else", () => {
    expect(parseInboxSpec("will:William:Jin")).toEqual({
      local: "will",
      givenName: "William",
      familyName: "Jin",
    });
    expect(() => parseInboxSpec("will:William")).toThrow(/local:Given:Family/);
    expect(() => parseInboxSpec("Will:W:J")).toThrow();
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
    // No inboxes is a domain-only plan (a site), not an error.
    expect(parsePlan({ domain: "ok.test" }).inboxes).toEqual([]);
    expect(() =>
      parsePlan({
        domain: "ok.test",
        inboxes: [{ local: "Bad Local", givenName: "A", familyName: "B" }],
      }),
    ).toThrow();
  });
});
