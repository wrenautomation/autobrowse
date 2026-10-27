import { describe, expect, it } from "vitest";
import type { StepRecord } from "../src/agent/explorer.js";
import { runJson } from "../src/agent/run-json.js";

const step = (n: number, over: Partial<StepRecord>): StepRecord => ({
  n,
  step: null,
  result: null,
  error: null,
  url: "https://a.test/",
  usage: { inputTokens: 100, outputTokens: 10 },
  ms: 5,
  batch: n,
  missed: null,
  ...over,
});

describe("runJson", () => {
  const steps = [
    step(1, {
      step: { thought: "the list is here", action: { cmd: "click", ref: 3, goal: "open it" } },
    }),
    step(2, {
      step: { thought: "read the price", action: { cmd: "read", ref: 4, as: "price" } },
      result: { text: "$40" },
    }),
    step(3, { error: "reply was not JSON" }),
  ];

  it("keeps steps as judge lines, with a read's text and no verdict while running", () => {
    const j = runJson("find the price", steps, ["a.png"], Date.now());
    expect(j.achieved).toBeNull();
    expect(j.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
    expect(j.steps.map((s) => s.cmd)).toEqual(["click", "read", "invalid"]);
    expect(j.steps[0]?.line).toBe(
      'Step 1 at https://a.test/: the list is here\n  click {"ref":3,"goal":"open it"}',
    );
    expect(j.steps[1]?.line).toContain('-> {"text":"$40"}');
    expect(j.steps[2]?.line).toBe("Step 3: unparsable reply (reply was not JSON)");
  });

  it("takes the verdict at the end", () => {
    const usage = { inputTokens: 1, outputTokens: 2 };
    const j = runJson("g", steps, [], Date.now(), { achieved: true, summary: "$40", usage });
    expect([j.achieved, j.summary, j.usage]).toEqual([true, "$40", usage]);
  });
});
