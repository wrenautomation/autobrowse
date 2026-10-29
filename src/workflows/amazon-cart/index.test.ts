import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({ browser: { run: async () => undefined as never } });

describe("amazon-cart", () => {
  it("parses the recorded example with defaults", () => {
    expect(planSchema.parse({ searchFor: "atomic habits" })).toMatchObject({
      department: "Books",
      quantity: 1,
    });
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true, searchFor: "atomic habits" });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("done");
  });
});
