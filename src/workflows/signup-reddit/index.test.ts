import { describe, expect, it } from "vitest";
import { memoryEffects, memorySecrets, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({
  browser: { run: async () => ({ asked: true }) as never },
  secrets: memorySecrets({ email: "x", password: "x", code: "x" }),
});

describe("signup-reddit", () => {
  it("takes a Reddit username and nothing else", () => {
    expect(planSchema.parse({ username: "quiet_ops_wren" }).dryRun).toBe(false);
    expect(() => planSchema.parse({ username: "u/with slash" })).toThrow();
  });

  it("dry run stops before the account is made", async () => {
    const plan = planSchema.parse({ dryRun: true, username: "quiet_ops_wren" });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("planned");
    expect(out.results["create-account"]?.status).toBe("planned");
  });
});
