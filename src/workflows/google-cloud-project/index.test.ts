import { describe, expect, it } from "vitest";
import { memoryEffects, memorySink, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({ browser: { run: async () => undefined as never }, sink: memorySink() });

describe("google-cloud-project", () => {
  it("parses the recorded example", () => {
    expect(planSchema.parse({ name: "wren" }).dryRun).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true, name: "wren" });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("planned");
    expect(out.results["create-project"]?.status).toBe("planned");
  });
});
