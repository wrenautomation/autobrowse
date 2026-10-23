import { describe, expect, it } from "vitest";
import type { AttemptInput, Quiz } from "../../browser/flows/learn.js";
import { memoryEffects, runFlow } from "../../index.js";
import { planSchema, workflow } from "./index.js";

const plan = (dryRun: boolean) =>
  planSchema.parse({
    dryRun,
    ou: 1285415,
    qi: 325153,
    answers: [{ question: 1, choices: ["The promise from the producer"] }],
  });

const quiz = (used: number): Quiz => ({ qi: 325153, name: "Nest", used, allowed: 1 });

const deps = (used: number, runs: AttemptInput[]) => ({
  browser: {
    run: async (flow: { name: string }, input: AttemptInput) => {
      if (flow.name === "quizzes") return [quiz(used)];
      runs.push(input);
      return { submitted: true, attempt: { ai: 1, score: "3 / 3 - 100 %", text: "" } };
    },
  } as never,
});

describe("learn-quiz-submit", () => {
  it("dry run checks the attempts left and never opens the quiz", async () => {
    const runs: AttemptInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(0, runs), plan(true));
    expect(out.status).toBe("planned");
    expect(runs).toEqual([]);
  });

  it("the submit waits at the send gate with the answers, then submits", async () => {
    const runs: AttemptInput[] = [];
    const { fx } = memoryEffects();
    const waiting = await runFlow(fx, workflow, deps(0, runs), plan(false));
    expect(waiting.status).toBe("waiting");
    const sent = await runFlow(fx, workflow, deps(0, runs), plan(false), (gate) => {
      expect(gate.prompt).toContain("Q1: The promise from the producer");
      return { approved: true, note: null, at: new Date().toISOString() };
    });
    expect(sent.status).toBe("done");
    expect(runs.map((r) => r.submit)).toEqual([true]);
    expect(sent.results.submit?.detail).toContain("3 / 3");
  });

  it("no attempt left skips the submit with no gate", async () => {
    const runs: AttemptInput[] = [];
    const out = await runFlow(memoryEffects().fx, workflow, deps(1, runs), plan(false));
    expect(out.status).toBe("done");
    expect(out.results.submit?.status).toBe("skipped");
    expect(runs).toEqual([]);
  });
});
