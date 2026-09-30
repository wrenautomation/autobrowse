import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StepRow } from "../src/agent/ledger.js";
import type { LlmCall } from "../src/llm/ledger.js";
import type { RunRow } from "../src/runs/log.js";
import {
  BASELINES,
  formatTokenReport,
  GOOD_PER_CALL,
  grade,
  readCmds,
  tokenReport,
} from "../src/runs/tokens.js";

const tmp = () => mkdtempSync(join(tmpdir(), "autobrowse-tokens-"));

const SINCE = "2026-09-01T00:00:00.000Z";
const UNTIL = "2026-09-30T23:59:59.999Z";
const IN = "2026-09-15T12:00:00.000Z";
const BEFORE = "2026-08-31T23:59:59.000Z";
const AFTER = "2026-10-01T00:00:01.000Z";

const call = (o: Partial<LlmCall> = {}): LlmCall => ({
  at: IN,
  model: "anthropic/sonnet",
  purpose: "agent-step",
  inputTokens: 1000,
  cachedTokens: 0,
  outputTokens: 100,
  ms: 10,
  ok: true,
  images: 0,
  promptChars: 10,
  ...o,
});

const step = (o: Partial<StepRow> = {}): StepRow => ({
  at: IN,
  session: "s1",
  site: "scratch",
  n: 1,
  model: "anthropic/sonnet",
  inputTokens: 3000,
  outputTokens: 80,
  cmd: "click",
  ok: true,
  error: null,
  ms: 10,
  host: "site.test",
  ...o,
});

type Cmd = Extract<RunRow, { kind: "cmd" }> & { site: string };
const cmd = (o: Partial<Cmd> = {}): Cmd => ({
  kind: "cmd",
  at: IN,
  n: 1,
  cmd: "click",
  ok: true,
  error: null,
  ms: 5,
  chars: 400,
  tokens: 100,
  full: 4000,
  host: "site.test",
  site: "scratch",
  ...o,
});

const report = (o: { calls?: LlmCall[]; cmds?: Cmd[]; steps?: StepRow[] }) =>
  tokenReport({
    since: SINCE,
    until: UNTIL,
    calls: o.calls ?? [],
    cmds: o.cmds ?? [],
    steps: o.steps ?? [],
  });

describe("grade", () => {
  it("is good up to a third of Stagehand, standard up to Stagehand, bad above", () => {
    expect(GOOD_PER_CALL).toBe(2300);
    expect(BASELINES.stagehand).toBe(6900);
    expect(grade(0)).toBe("good");
    expect(grade(2300)).toBe("good");
    expect(grade(2301)).toBe("standard");
    expect(grade(6900)).toBe("standard");
    expect(grade(6901)).toBe("bad");
  });
});

describe("tokenReport", () => {
  it("prefers the call ledger over steps.jsonl when it has agent steps", () => {
    const r = report({
      calls: [
        call({ inputTokens: 1000, outputTokens: 100 }),
        call({ inputTokens: 2000, outputTokens: 200 }),
        call({ inputTokens: 3000, outputTokens: 300 }),
        // A failed agent step is a call, not a step.
        call({ inputTokens: 0, outputTokens: 0, ok: false }),
      ],
      steps: [step({ inputTokens: 9000 }), step({ inputTokens: 10 })],
    });
    expect(r.steps).toEqual({
      counted: 3,
      uncounted: 0,
      medianInput: 2000,
      p90Input: 3000,
      meanOutput: 200,
      source: "llm",
    });
    expect(r.verdict.grade).toBe("good");
    expect(r.verdict.perCall).toBe(2000);
    expect(r.verdict.line).toMatch(/^good: median 2,000 input tokens per agent step/);
    expect(r.verdict.line).toContain("6.8x and 3.5x ours");
    expect(r.calls.n).toBe(4);
    expect(r.calls.failed).toBe(1);
  });

  it("falls back to steps.jsonl: rows under 50 input are uncounted, invalid replies dropped", () => {
    const r = report({
      calls: [call({ purpose: "repair", inputTokens: 500 })],
      steps: [
        step({ inputTokens: 10, outputTokens: 7 }),
        step({ inputTokens: 49 }),
        step({ inputTokens: 3000, outputTokens: 100 }),
        step({ inputTokens: 7000, outputTokens: 200 }),
        step({ inputTokens: 8000, outputTokens: 300 }),
        step({ inputTokens: 99_999, cmd: "invalid" }),
        step({ inputTokens: 99_999, at: BEFORE }),
        step({ inputTokens: 99_999, at: AFTER }),
      ],
    });
    expect(r.steps.source).toBe("steps");
    expect(r.steps.counted).toBe(3);
    expect(r.steps.uncounted).toBe(2);
    expect(r.steps.medianInput).toBe(7000);
    expect(r.verdict.grade).toBe("bad");
    // The mean output is over counted steps only.
    expect(r.steps.meanOutput).toBe(Math.round((100 + 200 + 300) / 3));
  });

  it("says so when nothing counted", () => {
    const none = report({});
    expect(none.steps.source).toBe("none");
    expect(none.verdict).toEqual({
      grade: null,
      perCall: null,
      line: "no agent steps counted in this window",
    });
    const onlyUncounted = report({ steps: [step({ inputTokens: 5 })] });
    expect(onlyUncounted.steps.source).toBe("steps");
    expect(onlyUncounted.steps.counted).toBe(0);
    expect(onlyUncounted.steps.uncounted).toBe(1);
    expect(onlyUncounted.verdict.grade).toBeNull();
  });

  it("sums calls by purpose and by model, biggest input first, inside the window only", () => {
    const r = report({
      calls: [
        call({ purpose: "repair", inputTokens: 100, cachedTokens: 10, outputTokens: 1 }),
        call({ purpose: "repair", inputTokens: 300, cachedTokens: 20, outputTokens: 2 }),
        call({ purpose: "repair", inputTokens: 200, cachedTokens: 30, outputTokens: 3 }),
        call({ purpose: "agent-step", inputTokens: 5000, model: "openai/gpt" }),
        call({ purpose: "late", inputTokens: 1, at: AFTER }),
        call({ purpose: "early", inputTokens: 1, at: BEFORE }),
      ],
    });
    expect(r.calls.byPurpose).toEqual([
      { purpose: "agent-step", n: 1, input: 5000, cached: 0, output: 100, medianInput: 5000 },
      { purpose: "repair", n: 3, input: 600, cached: 60, output: 6, medianInput: 200 },
    ]);
    expect(r.calls.byModel).toEqual([
      { model: "openai/gpt", n: 1, input: 5000, output: 100 },
      { model: "anthropic/sonnet", n: 3, input: 600, output: 6 },
    ]);
    expect(r.calls).toMatchObject({ n: 4, failed: 0, input: 5600, cached: 60, output: 106 });
  });

  it("sums explore answers by command and site, whole page as answered when not measured", () => {
    const r = report({
      cmds: [
        cmd({ cmd: "click", tokens: 100, full: 4000 }),
        cmd({ cmd: "click", tokens: 50, full: 2001 }),
        cmd({ cmd: "look", tokens: 300, full: null, site: "google" }),
        cmd({ cmd: "look", tokens: 999, at: AFTER }),
        cmd({ cmd: "look", tokens: 999, at: BEFORE }),
      ],
    });
    expect(r.answers.cmds).toBe(3);
    expect(r.answers.tokens).toBe(450);
    expect(r.answers.full).toBe(1000 + 501 + 300);
    expect(r.answers.byCmd).toEqual([
      { cmd: "look", n: 1, tokens: 300, full: 300 },
      { cmd: "click", n: 2, tokens: 150, full: 1501 },
    ]);
    expect(r.answers.bySite).toEqual([
      { site: "google", cmds: 1, tokens: 300 },
      { site: "scratch", cmds: 2, tokens: 150 },
    ]);
  });

  it("does not grade agent steps that reported no input tokens", () => {
    const r = report({ calls: [call({ inputTokens: 0 }), call({ inputTokens: 0 })] });
    expect(r.verdict.line).not.toContain("Infinity");
    expect(r.verdict.grade).toBeNull();
  });
});

describe("formatTokenReport", () => {
  it("prints the verdict, the calls by purpose, and the answers against whole pages", () => {
    const r = report({
      calls: [
        call({ inputTokens: 1500 }),
        call({ purpose: "repair", inputTokens: 400, model: "openai/gpt", ok: false }),
      ],
      cmds: [
        cmd({ cmd: "click", tokens: 100, full: 4000 }),
        cmd({ cmd: "look", tokens: 200, full: null, site: "google" }),
      ],
    });
    const lines = formatTokenReport(r);
    expect(lines[0]).toBe("tokens 2026-09-01 → 2026-09-30");
    expect(lines).toContain(`verdict: ${r.verdict.line}`);
    expect(lines.some((l) => l.startsWith("agent steps: 1 counted (call ledger)"))).toBe(true);
    expect(lines).toContain("model calls: 2 (1 failed), 1,900 in (0 cached), 200 out");
    expect(lines.some((l) => /^\s+purpose\s+calls\s+input/.test(l))).toBe(true);
    // Two models: one line each.
    expect(
      lines.filter((l) => l.includes("openai/gpt") || l.includes("anthropic/sonnet")),
    ).toHaveLength(2);
    expect(lines).toContain(
      "explore answers: 2 commands, ~300 tokens to the caller; whole-page answers would be ~1,200 (4.0x)",
    );
    expect(lines.some((l) => l.startsWith("  by site: "))).toBe(true);
  });

  it("leaves out what has nothing to show", () => {
    const lines = formatTokenReport(
      report({ cmds: [cmd({ tokens: 100, full: null })], steps: [step({ inputTokens: 5 })] }),
    );
    expect(lines.some((l) => l.startsWith("agent steps"))).toBe(false);
    expect(lines).toContain("model calls: 0, 0 in (0 cached), 0 out");
    expect(lines).toContain("explore answers: 1 commands, ~100 tokens to the caller");
    expect(lines.some((l) => l.includes("by site"))).toBe(false);
    expect(lines.some((l) => l.includes("whole-page"))).toBe(false);
  });

  it("names steps.jsonl and the uncounted rows when that is the source", () => {
    const lines = formatTokenReport(
      report({ steps: [step({ inputTokens: 3000 }), step({ inputTokens: 5 })] }),
    );
    expect(
      lines.some(
        (l) =>
          l.startsWith("agent steps: 1 counted (steps.jsonl)") &&
          l.includes("1 uncounted (driver did not report cache reads)"),
      ),
    ).toBe(true);
  });
});

describe("readCmds", () => {
  const rows = (...rs: object[]) => `${rs.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const cmdRow = (at: string, name = "click") => ({ ...cmd({ at, cmd: name }), site: undefined });

  it("is empty for a missing folder", () => {
    expect(readCmds(join(tmp(), "nope"), SINCE)).toEqual([]);
  });

  it("reads cmd rows since the time, with their site, from run files of that day or the day before", () => {
    const dir = tmp();
    mkdirSync(join(dir, "scratch"));
    mkdirSync(join(dir, "google"));
    writeFileSync(join(dir, "index.jsonl"), "{}\n");
    writeFileSync(
      join(dir, "scratch", "20260915-100000-aaaa.jsonl"),
      rows(
        { kind: "start", at: "2026-09-15T10:00:00.000Z" },
        cmdRow("2026-09-15T09:59:59.000Z", "early"),
        cmdRow("2026-09-15T10:00:01.000Z", "look"),
        { kind: "act", at: "2026-09-15T10:00:02.000Z" },
      ),
    );
    writeFileSync(
      join(dir, "google", "20260914-235900-bbbb.jsonl"),
      rows(cmdRow("2026-09-15T00:10:00.000Z", "click")),
    );
    writeFileSync(join(dir, "google", "notes.txt"), "not a run");
    const got = readCmds(dir, "2026-09-15T10:00:00.000Z");
    expect(got.map((c) => [c.site, c.cmd]).sort()).toEqual([["scratch", "look"]]);
    const wider = readCmds(dir, "2026-09-15T00:00:00.000Z");
    expect(wider.map((c) => [c.site, c.cmd]).sort()).toEqual([
      ["google", "click"],
      ["scratch", "early"],
      ["scratch", "look"],
    ]);
  });

  it("keeps a day's slack across a month start", () => {
    const dir = tmp();
    mkdirSync(join(dir, "scratch"));
    writeFileSync(
      join(dir, "scratch", "20260930-235000-aaaa.jsonl"),
      rows(
        cmdRow("2026-09-30T23:55:00.000Z", "before"),
        cmdRow("2026-10-01T00:00:05.000Z", "look"),
      ),
    );
    const got = readCmds(dir, "2026-10-01T00:00:00Z");
    expect(got.map((c) => c.cmd)).toEqual(["look"]);
  });

  it("keeps a day's slack across a year start", () => {
    const dir = tmp();
    mkdirSync(join(dir, "scratch"));
    writeFileSync(
      join(dir, "scratch", "20261231-235000-aaaa.jsonl"),
      rows(cmdRow("2027-01-01T00:00:05.000Z", "look")),
    );
    expect(readCmds(dir, "2027-01-01T00:00:00.000Z").map((c) => c.cmd)).toEqual(["look"]);
  });

  it("skips run files that started more than a day before the window (the slack is one day)", () => {
    const dir = tmp();
    mkdirSync(join(dir, "scratch"));
    writeFileSync(
      join(dir, "scratch", "20260929-235000-aaaa.jsonl"),
      rows(cmdRow("2026-10-01T00:00:05.000Z", "look")),
    );
    expect(readCmds(dir, "2026-10-01T00:00:00.000Z")).toEqual([]);
  });
});
