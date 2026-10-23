import { describe, expect, it } from "vitest";
import type { Folder, SubmitInput } from "../../browser/flows/learn.js";
import { memoryEffects, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const plan = (dryRun: boolean) =>
  planSchema.parse({ dryRun, ou: 1285415, db: 412350, file: "package.json" });

const folder = (submitted: boolean): Folder => ({
  db: 412350,
  name: "Assignment 3 (Part 1 of 2)",
  due: null,
  status: submitted ? "1 Submission, 1 File" : "Not Submitted",
  submitted,
});

const deps = (submitted: boolean, runs: SubmitInput[]) => ({
  browser: {
    run: async (flow: { name: string }, input: SubmitInput) => {
      if (flow.name === "dropbox") return [folder(submitted)];
      runs.push(input);
      return { submissionId: "13643610" };
    },
  } as never,
});

describe("learn-dropbox-submit", () => {
  it("dry run checks the folder and stops before the submit", async () => {
    const runs: SubmitInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(false, runs), plan(true));
    expect(out.status).toBe("planned");
    expect(runs).toEqual([]);
  });

  it("the submit waits at the send gate, then submits once approved", async () => {
    const runs: SubmitInput[] = [];
    const { fx } = memoryEffects();
    const waiting = await runFlow(fx, workflow, deps(false, runs), plan(false));
    expect(waiting.status).toBe("waiting");
    expect(runs).toEqual([]);
    const sent = await runFlow(fx, workflow, deps(false, runs), plan(false), (gate) => {
      expect(gate.name).toBe("send");
      expect(gate.prompt).toContain("Assignment 3");
      return { approved: true, note: null, at: new Date().toISOString() };
    });
    expect(sent.status).toBe("done");
    expect(runs.map((r) => r.submit)).toEqual([true]);
    expect(sent.results.submit?.detail).toContain("13643610");
  });

  it("a folder with a submission skips the submit with no gate", async () => {
    const runs: SubmitInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(true, runs), plan(false));
    expect(out.status).toBe("done");
    expect(out.results.submit?.status).toBe("skipped");
    expect(runs).toEqual([]);
  });
});
