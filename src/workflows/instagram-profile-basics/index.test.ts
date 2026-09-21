import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const deps = () => ({ browser: { run: async () => undefined as never } });

describe("instagram-profile-basics", () => {
  it("parses the recorded example", () => {
    expect(
      planSchema.parse({
        profilePhotoFile:
          "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-pfp.png",
      }).dryRun,
    ).toBe(false);
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({
      dryRun: true,
      profilePhotoFile:
        "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-pfp.png",
    });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("planned");
    expect(out.results["upload-profile-photo"]?.status).toBe("planned");
  });
});
