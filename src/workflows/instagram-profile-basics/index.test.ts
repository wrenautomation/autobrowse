import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { planSchema, type UploadProfilePhotoInput, workflow } from "./index.js";

const plan = (dryRun: boolean) =>
  planSchema.parse({
    dryRun,
    profilePhotoFile:
      "/Users/williamjin/Documents/wren_automation/autobrowse/assets/brand/wren-pfp.png",
  });

const deps = (runs: UploadProfilePhotoInput[]) => ({
  browser: {
    run: async (_flow: unknown, input: UploadProfilePhotoInput) => {
      runs.push(input);
      return { proof: input.submit ? "Profile picture updated successfully" : null };
    },
  } as never,
});

describe("instagram-profile-basics", () => {
  it("dry run fills the form and stops before the upload", async () => {
    const runs: UploadProfilePhotoInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(runs), plan(true));
    expect(out.status).toBe("planned");
    expect(runs.map((r) => r.submit)).toEqual([false]);
  });

  it("the upload waits at the send gate, then uploads once approved", async () => {
    const runs: UploadProfilePhotoInput[] = [];
    const { fx } = memoryEffects();
    const waiting = await runFlow(fx, workflow, deps(runs), plan(false));
    expect(waiting.status).toBe("waiting");
    expect(runs.map((r) => r.submit)).toEqual([false]);
    const uploaded = await runFlow(fx, workflow, deps(runs), plan(false), (gate) => {
      expect(gate.name).toBe("send");
      expect(gate.prompt).toContain("wren-pfp.png");
      return { approved: true, note: null, at: new Date().toISOString() };
    });
    expect(uploaded.status).toBe("done");
    expect(runs.map((r) => r.submit)).toEqual([false, true]);
    expect(uploaded.results.upload?.detail).toContain("uploaded");
  });
});
