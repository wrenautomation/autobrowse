import { describe, expect, it } from "vitest";
import { cloudflareAccountId, cloudflareApiToken } from "../src/browser/flows/cloudflare-token.js";
import { memorySink } from "../src/deps/sink.js";
import { runFlow } from "../src/engine/run.js";
import { type BootstrapDeps, bootstrapWorkflow } from "../src/workflows/bootstrap/index.js";
import { fakeBrowser, fakeEffects } from "./fakes.js";

function deps(
  over: Partial<BootstrapDeps> & {
    have?: { token?: string; account?: string };
    verify?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const browser = fakeBrowser(calls);
  browser.on(cloudflareAccountId, async () => ({ accountId: "a".repeat(32) }));
  browser.on(cloudflareApiToken, async ({ name }) => {
    calls.push(`mint ${name}`);
    return { token: "t".repeat(40) };
  });
  const sink = memorySink();
  const d: BootstrapDeps = {
    browser,
    sink,
    current: () => ({
      cloudflareApiToken: over.have?.token ?? null,
      cloudflareAccountId: over.have?.account ?? null,
    }),
    verifyCloudflareToken: async () => over.verify ?? true,
    ...over,
  };
  return { d, calls, sink };
}

const plan = (extra: Record<string, unknown> = {}) =>
  bootstrapWorkflow.plan.parse({ provider: "cloudflare", ...extra });

describe("bootstrap workflow", () => {
  it("mints, verifies and stores the account id and token", async () => {
    const { d, calls, sink } = deps();
    const out = await runFlow(fakeEffects().fx, bootstrapWorkflow, d, plan());
    expect(out.status).toBe("done");
    expect(calls).toEqual(["mint autobrowse"]);
    expect(Object.keys(sink.values).sort()).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
    ]);
  });
  it("skips what is already configured and verifies", async () => {
    const { d, calls, sink } = deps({ have: { token: "x", account: "y" } });
    const out = await runFlow(fakeEffects().fx, bootstrapWorkflow, d, plan());
    expect(out.results["account-id"]?.status).toBe("skipped");
    expect(out.results["api-token"]?.status).toBe("skipped");
    expect(calls).toEqual([]);
    expect(sink.values).toEqual({});
  });
  it("re-mints when the configured token no longer verifies", async () => {
    let verified = 0;
    const { d, sink } = deps({
      have: { token: "stale", account: "y" },
      verifyCloudflareToken: async (t) => {
        verified++;
        return t !== "stale";
      },
    });
    const out = await runFlow(fakeEffects().fx, bootstrapWorkflow, d, plan());
    expect(out.results["api-token"]?.status).toBe("done");
    expect(verified).toBe(2);
    expect(sink.values.CLOUDFLARE_API_TOKEN).toBe("t".repeat(40));
  });
  it("a minted token the API rejects fails the step and stores nothing", async () => {
    const { d, sink } = deps({ verify: false });
    const out = await runFlow(fakeEffects().fx, bootstrapWorkflow, d, plan());
    expect(out.status).toBe("failed");
    expect(sink.values.CLOUDFLARE_API_TOKEN).toBeUndefined();
  });
  it("dry run stops before minting", async () => {
    const { d, calls } = deps();
    const out = await runFlow(fakeEffects().fx, bootstrapWorkflow, d, plan({ dryRun: true }));
    expect(out.status).toBe("planned");
    expect(calls).toEqual([]);
  });
});
