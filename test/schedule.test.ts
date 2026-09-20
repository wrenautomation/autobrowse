import { describe, expect, it } from "vitest";
import type { Proposal } from "../src/agent/evaluator.js";
import { scheduleEvaluator, wording } from "../src/agent/schedule.js";

const p = (title: string, covered = false): Proposal => ({
  title,
  why: "w",
  site: "google",
  goal: `do ${title}`,
  occurrences: 2,
  covered,
});
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("scheduleEvaluator", () => {
  it("tells about fresh proposals once, skips covered ones, repeats on the clock", async () => {
    const notes: string[] = [];
    let calls = 0;
    let fire: () => void = () => undefined;
    const stop = scheduleEvaluator({
      everyHours: 6,
      evidence: async () => ({ failures: [], sessions: [], recordings: [] }),
      propose: async () => {
        calls++;
        return {
          proposals: calls === 1 ? [p("re-auth"), p("logo", true)] : [p("re-auth"), p("dns")],
        };
      },
      notify: async (t) => {
        notes.push(t);
      },
      setInterval: ((fn: () => void, ms: number) => {
        expect(ms).toBe(6 * 3_600_000);
        fire = fn;
        return 0 as never;
      }) as never,
    });
    await tick();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("- re-auth (2×): do re-auth");
    expect(notes[0]).not.toContain("logo");
    fire();
    await tick();
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain("dns");
    expect(notes[1]).not.toContain("re-auth");
    stop();
  });
  it("says nothing when everything is covered", () => {
    expect(wording([p("x", true)])).toBeNull();
    expect(wording([])).toBeNull();
  });
});
