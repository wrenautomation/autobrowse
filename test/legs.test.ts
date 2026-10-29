import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineFlow, type FlowRunner } from "../src/browser/flow.js";
import { FLOW_INPUTS } from "../src/browser/flows/inputs.gen.js";
import { BROWSER_FLOWS } from "../src/engine/browser-service.js";
import { memoryEffects } from "../src/engine/memory.js";
import { advance } from "../src/engine/run.js";
import { LEG_WORKFLOWS, legName, legWorkflow } from "../src/workflows/legs.js";

describe("the hand-written legs are workflows", () => {
  it("every leg has an input schema, and every workflow name is taken once", () => {
    const have = new Set(FLOW_INPUTS.map((e) => e.flow));
    const missing = Object.entries(BROWSER_FLOWS)
      .filter(([, f]) => !have.has(f))
      .map(([k]) => k);
    // A new leg needs `pnpm gen:flow-inputs`.
    expect(missing).toEqual([]);
    expect(LEG_WORKFLOWS.size).toBe(FLOW_INPUTS.length);
    const compiled = readdirSync(join(import.meta.dirname, "../src/workflows"), {
      withFileTypes: true,
    })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect([...LEG_WORKFLOWS.keys()].filter((n) => compiled.includes(n))).toEqual([]);
  });

  it("names a leg site-name, once", () => {
    expect(legName({ site: "google", name: "oauth-consent" })).toBe("google-oauth-consent");
    expect(legName({ site: "npm", name: "npm-create-org" })).toBe("npm-create-org");
  });

  it("an object input is the plan; the step runs the leg and keeps its answer", async () => {
    const seen: unknown[] = [];
    const flow = defineFlow<{ q: string; max?: number }, { hits: number }>({
      site: "web",
      name: "find",
      async run() {
        return { hits: 3 };
      },
    });
    const browser = {
      run: async (_f: unknown, input: unknown) => {
        seen.push(input);
        return { hits: 3 };
      },
    } as unknown as FlowRunner;
    const w = legWorkflow(flow, z.object({ q: z.string(), max: z.number().optional() }));
    const plan = w.plan.parse({ q: "dune" });
    expect(plan).toEqual({ q: "dune", dryRun: false });
    const fx = memoryEffects().fx;
    let a = await advance(fx, w, { browser }, plan);
    while (a.kind === "continue") a = await advance(fx, w, { browser }, plan);
    expect(a).toMatchObject({ kind: "finished", status: "done" });
    expect(seen).toEqual([{ q: "dune" }]);
    expect(() => w.plan.parse({})).toThrow();
  });

  it("a secret leg's step keeps no answer; a dry run never runs it", async () => {
    const flow = defineFlow<undefined, { token: string }>({
      site: "web",
      name: "mint",
      secret: true,
      async run() {
        return { token: "t" };
      },
    });
    let ran = 0;
    const browser = {
      run: async () => {
        ran++;
        return { token: "t" };
      },
    } as unknown as FlowRunner;
    const w = legWorkflow(flow, z.undefined());
    const fx = memoryEffects().fx;
    const dry = await advance(fx, w, { browser }, w.plan.parse({ dryRun: true }));
    expect(ran).toBe(0);
    expect(dry.kind).not.toBe("continue");
    const fx2 = memoryEffects().fx;
    let a = await advance(fx2, w, { browser }, w.plan.parse({}));
    while (a.kind === "continue") a = await advance(fx2, w, { browser }, w.plan.parse({}));
    expect(ran).toBe(1);
    expect(JSON.stringify(a)).not.toContain('"t"');
  });
});
