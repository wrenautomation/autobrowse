import { describe, expect, it } from "vitest";
import { runFlow } from "../src/engine/run.js";
import { domainWorkflow } from "../src/workflows/domain/index.js";
import { MAIN_SITE, PLACEHOLDER_IP, redirectWorkflow } from "../src/workflows/redirect/index.js";
import { senderDomainWorkflow } from "../src/workflows/sender-domain/index.js";
import { fakeCloudflare, fakeDeps, fakeEffects, scriptedAnswers } from "./fakes.js";

const redirect = (cf: ReturnType<typeof fakeCloudflare>, over: Record<string, unknown> = {}) =>
  runFlow(
    fakeEffects().fx,
    redirectWorkflow,
    { cloudflare: cf },
    redirectWorkflow.plan.parse({ domain: "wren-old.test", ...over }),
    scriptedAnswers({}).answer,
  );

describe("redirect workflow", () => {
  it("proxies the apex and www and 301s every URL to the main site", async () => {
    const cf = fakeCloudflare({ registered: true, zone: "z1" });
    const out = await redirect(cf);
    expect(out.status).toBe("done");
    expect(cf.records.map((r) => `${r.type} ${r.name} ${r.content} ${r.proxied}`)).toEqual([
      `A @ ${PLACEHOLDER_IP} true`,
      `A www ${PLACEHOLDER_IP} true`,
    ]);
    expect(cf.rules).toMatchObject([{ from: "*wren-old.test/*", to: MAIN_SITE, status: 301 }]);
  });

  it("a rerun keeps everything; a new target updates the one rule", async () => {
    const cf = fakeCloudflare({ registered: true, zone: "z1" });
    await redirect(cf);
    const again = await redirect(cf);
    expect(again.results["redirect-rule"]?.detail).toContain("kept");
    await redirect(cf, { redirectTo: "https://example.test" });
    expect(cf.rules).toHaveLength(1);
    expect(cf.rules[0]?.to).toBe("https://example.test");
    expect(cf.records).toHaveLength(2);
  });

  it("never clobbers a real site at the apex", async () => {
    const cf = fakeCloudflare({ registered: true, zone: "z1" });
    cf.records.push({ id: "r0", type: "A", name: "@", content: "203.0.113.9" });
    const out = await redirect(cf);
    expect(out.status).toBe("failed");
    expect(out.results["redirect-dns"]?.detail).toMatch(/already points at 203.0.113.9/);
    expect(cf.rules).toEqual([]);
  });

  it("stops on a domain with no zone", async () => {
    const out = await redirect(fakeCloudflare());
    expect(out.status).toBe("failed");
    expect(out.results["redirect-dns"]?.detail).toMatch(/no Cloudflare zone/);
  });
});

describe("sender-domain workflow", () => {
  it("is the domain steps, then the redirect ones", () => {
    expect(senderDomainWorkflow.steps.map((s) => s.name)).toEqual([
      ...domainWorkflow.steps.map((s) => s.name),
      "redirect-dns",
      "redirect-rule",
    ]);
  });

  it("provisions the domain and redirects its site", async () => {
    const deps = fakeDeps({ cloudflare: fakeCloudflare({ registered: true, zone: "z1" }) });
    const plan = senderDomainWorkflow.plan.parse({
      domain: "wren-new.test",
      inboxes: [{ local: "will", givenName: "William", familyName: "Jin" }],
    });
    const out = await runFlow(
      fakeEffects().fx,
      senderDomainWorkflow,
      deps,
      plan,
      scriptedAnswers({}).answer,
    );
    expect(out.status).toBe("done");
    expect(out.results["redirect-rule"]?.detail).toBe(
      `*wren-new.test/* → ${MAIN_SITE} (301, created)`,
    );
  });
});
