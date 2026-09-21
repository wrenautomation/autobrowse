import { describe, expect, it } from "vitest";
import { memoryEffects, memorySecrets, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({
  browser: { run: async () => undefined as never },
  secrets: memorySecrets({ code: "x" }),
});

describe("instagram-change-email", () => {
  it("parses the recorded example", () => {
    expect(planSchema.parse({ newEmail: "william@wrenautomation.com" }).dryRun).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true, newEmail: "william@wrenautomation.com" });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("planned");
    expect(out.results["add-and-verify-email"]?.status).toBe("planned");
  });
});
