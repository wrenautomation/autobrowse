import { describe, expect, it } from "vitest";
import { memoryEffects, memorySink, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({ browser: { run: async () => undefined as never }, sink: memorySink() });

describe("google-cloud-oauth-client", () => {
  it("parses the recorded example", () => {
    expect(
      planSchema.parse({
        project: "my-project-123456",
        api: "youtube.googleapis.com",
        appName: "Wren Automation",
        email: "you@example.com",
        clientName: "autobrowse",
        redirectUri: "http://127.0.0.1:9400/oauth/callback",
      }).dryRun,
    ).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({
      dryRun: true,
      project: "my-project-123456",
      api: "youtube.googleapis.com",
      appName: "Wren Automation",
      email: "you@example.com",
      clientName: "autobrowse",
      redirectUri: "http://127.0.0.1:9400/oauth/callback",
    });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("done");
  });
});
