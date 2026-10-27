import { describe, expect, it } from "vitest";
import { clip, exploreWithAgent } from "../src/agent/explorer.js";
import { memoryStepLedger } from "../src/agent/ledger.js";
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
        case "records":
          return { as: c.as, rows: 2, min: 1, first: '[{"title":"A"},{"title":"B"}]' };
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
    const ledger = memoryStepLedger();
    const r = await exploreWithAgent({
      explorer: ex,
      llm,
      goal: "make sure dark mode is on",
      ledger,
      session: "s-1",
      site: "site",
    });
    expect(r.achieved).toBe(true);
    expect(r.steps.map((s) => s.step?.action.cmd)).toEqual(["click", "done"]);
    // Every step is a ledger row with its own spend and time, never the page.
    await new Promise((ok) => setTimeout(ok, 0));
    expect(ledger.rows.map((x) => [x.session, x.site, x.n, x.cmd, x.ok, x.host])).toEqual([
      ["s-1", "site", 1, "click", true, "site.test"],
      ["s-1", "site", 2, "done", true, "site.test"],
    ]);
    expect(ledger.rows[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(r.steps[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(JSON.stringify(ledger.rows)).not.toContain("Settings");
    expect(calls.find((c) => c.cmd === "click")).toMatchObject({
      hints: { role: "button", name: "Settings" },
    });
    expect(
      calls.filter((c) => c.cmd === "note").map((c) => (c.cmd === "note" ? c.text : "")),
    ).toEqual(["home page; settings is the way", "dark mode is on"]);
    expect(llm.requests[0]?.prompt).toContain("[1]B Settings");
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
  it("with desktop off, offers no os act and refuses one sent", async () => {
    const { ex, calls } = fakeExplorer(['- button "Only"']);
    const llm = fakeLlm([
      { thought: "shell", action: { cmd: "os", act: { op: "tree" }, goal: "x" } },
      { thought: "ok", action: { cmd: "done", summary: "s", achieved: true } },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "g", desktop: false });
    expect(llm.requests[0]?.system).not.toContain('"os"');
    expect(llm.requests[0]?.system).toContain("captcha, keep.");
    expect(r.steps[0]?.error).toMatch(/os acts are off/);
    expect(calls.some((c) => c.cmd === "os")).toBe(false);
    expect(r.achieved).toBe(true);
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
  it("reads a list as one records act and sees its rows next turn", async () => {
    const { ex, calls } = fakeExplorer(['- link "A"\n- link "B"']);
    const fields = [{ key: "title", says: "the story's title" }];
    const llm = fakeLlm([
      {
        thought: "a list",
        action: { cmd: "records", as: "stories", goal: "the stories", fields, max: 5 },
      },
      { thought: "fine", action: { cmd: "done", summary: "A, B", achieved: true } },
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "list the stories" });
    expect(calls.find((c) => c.cmd === "records")).toEqual({
      cmd: "records",
      as: "stories",
      goal: "the stories",
      fields,
      max: 5,
    });
    expect(llm.requests[1]?.prompt).toContain("ok, 2 rows; the first:");
    expect(r.achieved).toBe(true);
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

/** A one-screen form: the page's state is a script the test and each act may change. */
interface FormPage {
  url: string;
  dialogs: number;
  alerts: number;
  invalid: number;
  paused: boolean;
  /** Names a locator no longer finds, or finds disabled. */
  gone: Set<string>;
  disabled: Set<string>;
}

const FORM = [
  '- textbox "First name"',
  '- textbox "Last name"',
  '- combobox "Country"',
  '- checkbox "I agree"',
  '- button "Next"',
  '- textbox "Broken"',
].join("\n");

function formExplorer(after: (c: ExploreCommand, page: FormPage) => void = () => {}) {
  const page: FormPage = {
    url: "https://site.test/apply",
    dialogs: 0,
    alerts: 0,
    invalid: 0,
    paused: false,
    gone: new Set(),
    disabled: new Set(),
  };
  const calls: ExploreCommand[] = [];
  const ex: Explorer = {
    port: 0,
    token: "t",
    paused: () => page.paused,
    resumed: async () => {},
    done: Promise.resolve(),
    async exec(c) {
      calls.push(c);
      switch (c.cmd) {
        case "url":
          return { url: page.url };
        case "aria":
          return { aria: FORM };
        case "count":
          return { count: page.gone.has(c.hints.name ?? "") ? 0 : 1 };
        case "eval":
          if (c.hints) return { result: !page.disabled.has(c.hints.name ?? "") };
          return { result: { dialogs: page.dialogs, alerts: page.alerts, invalid: page.invalid } };
        case "fill":
        case "select":
        case "click":
          if (c.hints.name === "Broken") throw new Error("locator.fill: Timeout 10000ms exceeded.");
          after(c, page);
          return { url: page.url };
        default:
          return { ok: true };
      }
    },
  };
  /** The acts the browser ran, in order: what the journal holds. */
  const acts = () =>
    calls.flatMap((c) =>
      c.cmd === "fill" || c.cmd === "select" || c.cmd === "click"
        ? [`${c.cmd} ${c.hints.name}`]
        : [],
    );
  return { ex, calls, page, acts };
}

const fill = (ref: number, value: string) => ({ cmd: "fill", ref, value, goal: "answer" });
const done = { thought: "sent", actions: [{ cmd: "done", summary: "sent", achieved: true }] };

describe("exploreWithAgent batches", () => {
  it("runs a whole plan for one screen on one model call, one journal entry per act", async () => {
    const { ex, calls, acts } = formExplorer();
    const llm = fakeLlm([
      {
        thought: "the form; fill it and go on",
        actions: [
          fill(1, "Jane"),
          fill(2, "Doe"),
          { cmd: "select", ref: 3, value: "Canada", goal: "country" },
          { cmd: "click", ref: 4, goal: "agree" },
          { cmd: "click", ref: 5, goal: "next" },
        ],
      },
      done,
    ]);
    const ledger = memoryStepLedger();
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "apply", ledger });
    expect(r.achieved).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(acts()).toEqual([
      "fill First name",
      "fill Last name",
      "select Country",
      "click I agree",
      "click Next",
    ]);
    expect(r.steps.map((s) => [s.n, s.batch, s.step?.action.cmd, s.missed])).toEqual([
      [1, 1, "fill", null],
      [2, 1, "fill", null],
      [3, 1, "select", null],
      [4, 1, "click", null],
      [5, 1, "click", null],
      [6, 6, "done", null],
    ]);
    // The model's spend is on the batch's first act.
    expect(r.steps.map((s) => s.usage.inputTokens)).toEqual([10, 0, 0, 0, 0, 10]);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    // One thought per page, as an unbatched run journals it.
    expect(calls.filter((c) => c.cmd === "note")).toHaveLength(2);
    // Each act after the first is checked first: found, then shown and enabled.
    expect(calls.filter((c) => c.cmd === "count").map((c) => "hints" in c && c.hints.name)).toEqual(
      ["Last name", "Country", "I agree", "Next"],
    );
    await new Promise((ok) => setTimeout(ok, 0));
    expect(ledger.rows.map((x) => [x.n, x.cmd, x.missed])).toEqual([
      [1, "fill", null],
      [2, "fill", null],
      [3, "select", null],
      [4, "click", null],
      [5, "click", null],
      [6, "done", null],
    ]);
    expect(llm.requests[0]?.system).toContain("1 to 6 actions");
    expect(llm.requests[1]?.prompt).toContain("5. click [5] → ok");
    expect(llm.requests[1]?.prompt).not.toContain("NOT RUN");
  });

  it.each([
    ["gone", (p: FormPage) => p.gone.add("Last name"), /the next target was gone/],
    ["gone", (p: FormPage) => p.disabled.add("Last name"), /the next target was gone/],
    ["navigated", (p: FormPage) => (p.url = "https://site.test/apply/2"), /the URL changed/],
    ["dialog", (p: FormPage) => p.dialogs++, /a dialog opened/],
    ["invalid", (p: FormPage) => p.invalid++, /an alert or an invalid field/],
    ["invalid", (p: FormPage) => p.alerts++, /an alert or an invalid field/],
  ] as const)("ends the batch on a miss: %s", async (kind, change, said) => {
    const { ex, acts } = formExplorer((c, page) => {
      if (c.cmd === "fill" && c.hints.name === "First name") change(page);
    });
    const llm = fakeLlm([
      { thought: "fill the form", actions: [fill(1, "Jane"), fill(2, "Doe"), fill(2, "Again")] },
      done,
    ]);
    const ledger = memoryStepLedger();
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "apply", ledger });
    expect(acts()).toEqual(["fill First name"]);
    expect(r.steps.map((s) => [s.step?.action.cmd, s.missed])).toEqual([
      ["fill", kind],
      ["done", null],
    ]);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(ledger.rows[0]?.missed).toBe(kind);
    const next = llm.requests[1]?.prompt ?? "";
    expect(next).toMatch(said);
    expect(next).toContain(
      'NOT RUN: fill [2] "Doe"; fill [2] "Again" (the plan stopped after step 1',
    );
  });

  it("ends the batch on an act that throws", async () => {
    const { ex, acts } = formExplorer();
    const llm = fakeLlm([{ thought: "fill", actions: [fill(6, "x"), fill(1, "Jane")] }, done]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "apply" });
    expect(acts()).toEqual(["fill Broken"]);
    expect(r.steps[0]).toMatchObject({ missed: "error", error: expect.stringMatching(/Timeout/) });
    expect(llm.requests[1]?.prompt).toContain(
      'NOT RUN: fill [1] "Jane" (the plan stopped after step 1: the act failed)',
    );
  });

  it("ends the batch after a button click, whatever the model planned after it", async () => {
    const { ex, calls, acts } = formExplorer();
    const llm = fakeLlm([
      {
        thought: "next, then more",
        actions: [fill(1, "Jane"), { cmd: "click", ref: 5, goal: "next" }, fill(2, "Doe")],
      },
      done,
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "apply" });
    expect(acts()).toEqual(["fill First name", "click Next"]);
    expect(r.steps.map((s) => s.missed)).toEqual([null, null, null]);
    // The click is never checked against what follows it: nothing follows it.
    expect(calls.filter((c) => c.cmd === "count")).toHaveLength(1);
    expect(llm.requests[1]?.prompt).toContain(
      'NOT RUN: fill [2] "Doe" (a click like step 2 is always the last action run)',
    );
  });

  it("stops between acts when a person pauses", async () => {
    const { ex, acts } = formExplorer((_c, page) => {
      page.paused = true;
    });
    const llm = fakeLlm([{ thought: "fill", actions: [fill(1, "Jane"), fill(2, "Doe")] }, done]);
    await exploreWithAgent({ explorer: ex, llm, goal: "apply" });
    expect(acts()).toEqual(["fill First name"]);
    expect(llm.requests[1]?.prompt).toContain("(a person paused the run)");
  });

  it("runs the acts before a trailing done and drops it; keeps human alone", async () => {
    const { ex, acts } = formExplorer();
    const llm = fakeLlm([
      {
        thought: "fill and finish",
        actions: [fill(1, "Jane"), { cmd: "done", summary: "s", achieved: true }],
      },
      // Refused, and refused again on the one retry.
      { thought: "ask", actions: [{ cmd: "human", reason: "money" }, fill(1, "Jane")] },
      { thought: "ask", actions: [{ cmd: "human", reason: "money" }, fill(1, "Jane")] },
      done,
    ]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "apply" });
    // The model sees the filled page before it says done.
    expect(acts()).toEqual(["fill First name"]);
    expect(r.steps[1]?.step).toBeNull();
    expect(r.steps[1]?.error).toMatch(/done and human must be the only action/);
    expect(r.achieved).toBe(true);
  });

  it("runs at most maxBatch acts and stays within the step budget", async () => {
    const plan = {
      thought: "fill",
      actions: [fill(1, "a"), fill(2, "b"), fill(1, "c"), fill(2, "d")],
    };
    const two = formExplorer();
    const llm2 = fakeLlm([plan, done]);
    await exploreWithAgent({ explorer: two.ex, llm: llm2, goal: "apply", maxBatch: 2 });
    expect(two.acts()).toEqual(["fill First name", "fill Last name"]);
    expect(llm2.requests[1]?.prompt).toContain(
      'NOT RUN: fill [1] "c"; fill [2] "d" (more than 2 actions, or past the step budget)',
    );
    const budget = formExplorer();
    const r = await exploreWithAgent({
      explorer: budget.ex,
      llm: fakeLlm([plan]),
      goal: "apply",
      maxSteps: 3,
    });
    expect(budget.acts()).toHaveLength(3);
    expect(r.summary).toMatch(/no verdict after 3 steps/);
  });

  it("at maxBatch 1 works as before: one act a call, no checks", async () => {
    const { ex, calls, acts } = formExplorer();
    const llm = fakeLlm([{ thought: "fill", actions: [fill(1, "Jane"), fill(2, "Doe")] }, done]);
    const r = await exploreWithAgent({ explorer: ex, llm, goal: "apply", maxBatch: 1 });
    expect(acts()).toEqual(["fill First name"]);
    expect(r.steps.map((s) => s.batch)).toEqual([1, 2]);
    expect(calls.some((c) => c.cmd === "count" || c.cmd === "eval")).toBe(false);
    expect(llm.requests[0]?.system).toContain("exactly one action");
    expect(llm.requests[0]?.system).not.toContain("Plan several actions");
  });
});

describe("clip", () => {
  it("cuts long strings anywhere in a result and leaves the rest alone", () => {
    const long = "x".repeat(10);
    expect(clip({ tree: long, apps: [long, "a"], code: 0, ok: true }, 4)).toEqual({
      tree: "xxxx…",
      apps: ["xxxx…", "a"],
      code: 0,
      ok: true,
    });
    expect(clip(null)).toBeNull();
  });
});
