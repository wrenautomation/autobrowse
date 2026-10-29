import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { dayButton, planSchema, workflow } from "./index.js";

const EXAMPLE = { where: "Lisbon", checkIn: "2026-11-20", checkOut: "2026-11-22" };
const deps = () => ({ browser: { run: async () => undefined as never } });

describe("airbnb-search", () => {
  it("parses the recorded example", () => {
    expect(planSchema.parse(EXAMPLE)).toMatchObject({ dryRun: false, adults: 2 });
  });

  it("names a day as the calendar's button does", () => {
    expect(dayButton("2026-11-20")).toBe("/^20, Friday, November 2026\\./");
  });

  it("dry run plans and stops before anything irreversible", async () => {
    const plan = planSchema.parse({ ...EXAMPLE, dryRun: true });
    const out = await runFlow(memoryEffects().fx, workflow, deps(), plan);
    expect(out.status).toBe("done");
  });
});
