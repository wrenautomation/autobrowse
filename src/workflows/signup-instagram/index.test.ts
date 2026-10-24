import { describe, expect, it } from "vitest";
import { memoryEffects, memorySecrets, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({
  browser: { run: async () => undefined as never },
  secrets: memorySecrets({ email: "x", password: "x", code: "x" }),
});

describe("signup-instagram", () => {
  it("parses the recorded example", () => {
    expect(planSchema.parse({ fullName: "Acme", username: "acme" }).dryRun).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({
      dryRun: true,
      fullName: "Acme",
      username: "acme",
    });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("planned");
    expect(out.results["submit-signup-form"]?.status).toBe("planned");
  });
});
