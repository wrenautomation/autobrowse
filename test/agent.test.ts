import { describe, expect, it } from "vitest";
import { exploreWithAgent } from "../src/agent/explorer.js";
import type { ExploreCommand, Explorer } from "../src/explore/server.js";
import { fakeLlm } from "../src/llm/fake.js";

/** An explorer whose page is a script of aria trees; records what it was told. */
function fakeExplorer(trees: string[]) {
  const calls: ExploreCommand[] = [];
  let i = 0;
  let paused = false;
  const ex: Explorer = {
    port: 0,
    token: "t",
    paused: () => paused,
    resumed: async () => {},
    done: Promise.resolve(),
    async exec(c) {
      calls.push(c);
      switch (c.cmd) {
        case "url":
          return { url: `https://site.test/p${i}` };
        case "aria":
          return { aria: trees[Math.min(i, trees.length - 1)] };
        case "click":
          if (c.hints.name === "Missing")
            throw new Error("locator.click: Timeout 10000ms exceeded.");
          i++;
          return { url: `https://site.test/p${i}` };
        case "read":
          return { as: c.as, text: `text of ${c.hints.name}` };
        case "pause":
          paused = true;
          return { paused };
        default:
          return { ok: true };
      }
    },
  };
  return { ex, calls };
}

describe("exploreWithAgent", () => {
  it("observes, acts, journals one thought per page, and stops on done", async () => {
    const { ex, calls } = fakeExplorer([
      '- button "Settings"',
      '- heading "Settings" - checkbox "Dark" [checked]',
    ]);
    const llm = fakeLlm([
      {
        thought: "home page; settings is the way",
        action: { cmd: "click", ref: 1, goal: "open settings" },
      },
      {
        thought: "dark mode is on",
        action: { cmd: "done", summary: "dark mode already on", achieved: true },
      },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "make sure dark mode is on" });
    expect(r.achieved).toBe(true);
    expect(r.steps.map((s) => s.step?.action.cmd)).toEqual(["click", "done"]);
    expect(calls.find((c) => c.cmd === "click")).toMatchObject({
      hints: { role: "button", name: "Settings" },
    });
    expect(
      calls.filter((c) => c.cmd === "note").map((c) => (c.cmd === "note" ? c.text : "")),
    ).toEqual(["home page; settings is the way", "dark mode is on"]);
    expect(llm.requests[0]?.prompt).toContain('[1] button "Settings"');
    expect(llm.requests[1]?.prompt).toContain("1. click [1]");
    expect(llm.requests[1]?.prompt).toContain("→ ok");
  });
  it("feeds a failed step back and stops at the budget", async () => {
    const { ex } = fakeExplorer(['- button "Real"\n- button "Missing"']);
    const llm = fakeLlm([
      { thought: "try", action: { cmd: "click", ref: 2, goal: "x" } },
      { thought: "again", action: { cmd: "click", ref: 2, goal: "x" } },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "g", maxSteps: 2 });
    expect(r.achieved).toBe(false);
    expect(r.steps[0]?.error).toMatch(/Timeout/);
    expect(llm.requests[1]?.prompt).toContain("FAILED: locator.click");
    expect(r.summary).toMatch(/no verdict after 2 steps/);
  });
  it("rejects a ref the digest never listed, without touching the browser", async () => {
    const { ex, calls } = fakeExplorer(['- button "Only"']);
    const llm = fakeLlm([
      { thought: "guess", action: { cmd: "click", ref: 9, goal: "x" } },
      { thought: "ok", action: { cmd: "done", summary: "s", achieved: false } },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "g" });
    expect(r.steps[0]?.error).toMatch(/ref 9 is not on the page; refs go 1..1/);
    expect(calls.some((c) => c.cmd === "click")).toBe(false);
  });
  it("treats an unparsable reply as a failed step and goes on", async () => {
    const { ex } = fakeExplorer(['- button "A"']);
    const llm = fakeLlm([
      { thought: "x", action: { cmd: "navigate", url: "https://x" } },
      { thought: "x", action: { cmd: "navigate", url: "https://x" } },
      { thought: "fine", action: { cmd: "done", summary: "s", achieved: true } },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "g" });
    expect(r.steps[0]?.step).toBeNull();
    expect(r.steps[0]?.error).toMatch(/not a valid action/);
    expect(r.achieved).toBe(true);
  });
  it("pushes back once on an early give-up, then accepts it", async () => {
    const { ex } = fakeExplorer(['- link "Name Jane Doe"']);
    const llm = fakeLlm([
      { thought: "nothing here", action: { cmd: "done", summary: "no name", achieved: false } },
      { thought: "still nothing", action: { cmd: "done", summary: "no name", achieved: false } },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "report the name" });
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]?.error).toMatch(/gave up at step 1/);
    expect(llm.requests[1]?.prompt).toContain("FAILED: you gave up");
    expect(r).toMatchObject({ achieved: false, summary: "no name" });
  });
  it("with onHuman, a human step continues after the person says so", async () => {
    const { ex } = fakeExplorer(['- button "Buy now"']);
    const llm = fakeLlm([
      { thought: "money", action: { cmd: "human", reason: "a purchase" } },
      { thought: "bought by hand", action: { cmd: "done", summary: "bought", achieved: true } },
    ]);
    const asked: string[] = [];
    const r = await exploreWithAgent({
      explorer: ex,
      llm,
      goal: "buy it",
      onHuman: async (reason) => {
        asked.push(reason);
        return true;
      },
    });
    expect(asked).toEqual(["a purchase"]);
    expect(r).toMatchObject({ achieved: true, summary: "bought" });
  });
  it("reads an element under a name and sees the text next turn", async () => {
    const { ex, calls } = fakeExplorer(['- heading "Welcome, Jane" [level=1]\n- button "Go"']);
    const llm = fakeLlm([
      { thought: "read it", action: { cmd: "read", ref: 1, as: "greeting" } },
      { thought: "done", action: { cmd: "done", summary: "Welcome, Jane", achieved: true } },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "report the greeting" });
    expect(r.achieved).toBe(true);
    expect(calls.find((c) => c.cmd === "read")).toMatchObject({
      hints: { role: "heading", name: "Welcome, Jane" },
      as: "greeting",
    });
    expect(llm.requests[1]?.prompt).toContain('read [1] as greeting → ok: "text of Welcome, Jane"');
  });
  it("hands over on human", async () => {
    const { ex } = fakeExplorer(['- button "Buy now"']);
    const llm = fakeLlm([{ thought: "money", action: { cmd: "human", reason: "a purchase" } }]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "buy it" });
    expect(r).toMatchObject({ achieved: false, summary: "a purchase" });
  });
});
