import { describe, expect, it } from "vitest";
import { memoryEffects, memorySink, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({ browser: { run: async () => undefined as never }, sink: memorySink() });

describe("langfuse-project-keys", () => {
  it("parses the recorded example", () => {
    expect(planSchema.parse({ noteOptional: "autobrowse tracing" }).dryRun).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ dryRun: true, noteOptional: "autobrowse tracing" });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("planned");
    expect(out.results["create-new-api-keys"]?.status).toBe("planned");
  });
});
