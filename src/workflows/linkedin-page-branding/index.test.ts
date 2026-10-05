import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { type BrandPageInput, planSchema, workflow } from "./index.js";

const plan = (dryRun: boolean, extra: Record<string, string> = {}) =>
  planSchema.parse({
    dryRun,
    logoFile: "/tmp/wren-pfp.png",
    bannerFile: "/tmp/wren-banner.png",
    website: "https://wrenautomation.com",
    ...extra,
  });

const deps = (runs: BrandPageInput[]) => ({
  browser: {
    run: async (_flow: unknown, input: BrandPageInput) => {
      runs.push(input);
      return {
        proof: input.submit ? "saved logo, banner, website https://wrenautomation.com" : null,
      };
    },
  } as never,
});

describe("linkedin-page-branding", () => {
  it("dry run opens the editor and changes nothing", async () => {
    const runs: BrandPageInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(runs), plan(true));
    expect(out.status).toBe("planned");
    expect(runs.map((r) => r.submit)).toEqual([false]);
    expect(runs[0]?.companyId).toBe("143656154");
  });

  it("waits at the send gate, then saves once approved", async () => {
    const runs: BrandPageInput[] = [];
    const { fx } = memoryEffects();
    const waiting = await runFlow(fx, workflow, deps(runs), plan(false));
    expect(waiting.status).toBe("waiting");
    const saved = await runFlow(fx, workflow, deps(runs), plan(false), (gate) => {
      expect(gate.name).toBe("send");
      expect(gate.prompt).toContain("wren-banner.png");
      return { approved: true, note: null, at: new Date().toISOString() };
    });
    expect(saved.status).toBe("done");
    expect(runs.map((r) => r.submit)).toEqual([false, true]);
    expect(saved.results.brand?.detail).toContain("banner");
  });

  it("skips the change when nothing is given", async () => {
    const runs: BrandPageInput[] = [];
    const out = await runFlow(
      memoryEffects().fx,
      workflow,
      deps(runs),
      planSchema.parse({ dryRun: false }),
    );
    expect(out.status).toBe("done");
    expect(runs.map((r) => r.submit)).toEqual([false]);
  });
});
