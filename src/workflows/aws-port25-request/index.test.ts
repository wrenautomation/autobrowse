import { describe, expect, it } from "vitest";
import { memoryEffects, runFlow } from "../../index.js";
import { type FormInput, planSchema, workflow } from "./index.js";

const plan = (dryRun: boolean) =>
  planSchema.parse({
    dryRun,
    contactEmail: "owner@example.com",
    useCaseDescription: "SMTP verification probes from one host; no mail sent.",
    elasticIpAddress: "34.233.233.146",
    reverseDnsRecord: "probe.wrenautomation.com",
  });

const deps = (runs: FormInput[]) => ({
  browser: {
    run: async (_flow: unknown, input: FormInput) => {
      runs.push(input);
      return { confirmation: input.submit ? "Thank you, your request has been submitted" : null };
    },
  } as never,
});

describe("aws-port25-request", () => {
  it("dry run fills the form and stops before the submit", async () => {
    const runs: FormInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(runs), plan(true));
    expect(out.status).toBe("planned");
    expect(runs.map((r) => r.submit)).toEqual([false]);
  });

  it("the submit waits at the send gate, then sends once approved", async () => {
    const runs: FormInput[] = [];
    const { fx } = memoryEffects();
    const waiting = await runFlow(fx, workflow, deps(runs), plan(false));
    expect(waiting.status).toBe("waiting");
    expect(runs.map((r) => r.submit)).toEqual([false]);
    const sent = await runFlow(fx, workflow, deps(runs), plan(false), (gate) => {
      expect(gate.name).toBe("send");
      expect(gate.prompt).toContain("owner@example.com");
      return { approved: true, note: null, at: new Date().toISOString() };
    });
    expect(sent.status).toBe("done");
    expect(runs.map((r) => r.submit)).toEqual([false, true]);
    expect(sent.results.submit?.detail).toContain("submitted");
  });
});
