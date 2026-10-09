/**
 * What autobrowse spends in tokens, and whether that is good. Three
 * sources: every model call (`llm/ledger`, by purpose), every explore
 * answer (run `cmd` rows: what the caller's context paid, against the
 * whole page it would have read instead), and agent steps from before the
 * call ledger (`steps.jsonl`). The verdict is input tokens per agent step
 * against published numbers for tools that send the page every step.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StepRow } from "../agent/ledger.js";
import type { LlmCall } from "../llm/ledger.js";
import { type RunRow, readRun } from "./log.js";

/**
 * Input tokens per model call, from stagehand.dev/blog/playwright-mcp-token-usage
 * (2026): Playwright MCP sends the accessibility snapshot every act
 * (12.9k–14.1k), Stagehand v4 a trimmed one (6.9k).
 */
export const BASELINES = { playwrightMcp: 13_500, stagehand: 6_900 } as const;
/** A third of the best baseline or less is good; up to it is standard; above it is bad. */
export const GOOD_PER_CALL = 2_300;
/** Rows under this many input tokens are a driver that did not count (cache reads unseen), not a real step. */
const UNCOUNTED = 50;

export type Grade = "good" | "standard" | "bad";
export const grade = (perCall: number): Grade =>
  perCall <= GOOD_PER_CALL ? "good" : perCall <= BASELINES.stagehand ? "standard" : "bad";

export type Cmd = Extract<RunRow, { kind: "cmd" }> & { site: string };

export interface TokenReport {
  since: string;
  until: string;
  steps: {
    counted: number;
    uncounted: number;
    medianInput: number;
    p90Input: number;
    meanOutput: number;
    /** Where the numbers came from: the call ledger, or steps.jsonl before it existed. */
    source: "llm" | "steps" | "none";
  };
  calls: {
    n: number;
    failed: number;
    input: number;
    cached: number;
    output: number;
    byPurpose: {
      purpose: string;
      n: number;
      input: number;
      cached: number;
      output: number;
      medianInput: number;
    }[];
    byModel: { model: string; n: number; input: number; output: number }[];
  };
  answers: {
    cmds: number;
    tokens: number;
    /** The same commands answered with the whole page every time. */
    full: number;
    byCmd: { cmd: string; n: number; tokens: number; full: number }[];
    bySite: { site: string; cmds: number; tokens: number }[];
  };
  verdict: { grade: Grade | null; perCall: number | null; line: string };
}

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/** Every explore answer since `since`, from run files whose id says they could hold one. */
export function readCmds(runsDir: string, since: string): Cmd[] {
  if (!existsSync(runsDir)) return [];
  // A run that started before the window can still have answered in it: a day's slack is enough for a session.
  const day = new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const out: Cmd[] = [];
  for (const site of readdirSync(runsDir, { withFileTypes: true })) {
    if (!site.isDirectory()) continue;
    for (const f of readdirSync(join(runsDir, site.name))) {
      if (!f.endsWith(".jsonl") || f.slice(0, 8) < day) continue;
      for (const r of readRun(join(runsDir, site.name, f)))
        if (r.kind === "cmd" && r.at >= since) out.push({ ...r, site: site.name });
    }
  }
  return out;
}

export function tokenReport(o: {
  since: string;
  until: string;
  calls: readonly LlmCall[];
  cmds: readonly Cmd[];
  steps: readonly StepRow[];
}): TokenReport {
  const calls = o.calls.filter((c) => c.at >= o.since && c.at <= o.until);
  const agentCalls = calls.filter((c) => c.purpose === "agent-step" && c.ok);
  const oldSteps = o.steps.filter((s) => s.at >= o.since && s.at <= o.until && s.cmd !== "invalid");
  // A driver that reports no usage writes 0: a step it did not count, never a cheap one.
  const counts = (r: { inputTokens: number }) => r.inputTokens >= UNCOUNTED;
  const fromLlm = agentCalls.some(counts);
  const rows: readonly { inputTokens: number; outputTokens: number }[] = fromLlm
    ? agentCalls
    : oldSteps;
  const inputs = rows.filter(counts).map((r) => r.inputTokens);
  const outputs = rows.filter(counts).map((r) => r.outputTokens);
  const uncounted = rows.length - inputs.length;
  const median = pct(inputs, 50);

  const byPurpose = [...groupBy(calls, (c) => c.purpose)]
    .map(([purpose, cs]) => ({
      purpose,
      n: cs.length,
      input: sum(cs.map((c) => c.inputTokens)),
      cached: sum(cs.map((c) => c.cachedTokens)),
      output: sum(cs.map((c) => c.outputTokens)),
      medianInput: pct(
        cs.map((c) => c.inputTokens),
        50,
      ),
    }))
    .sort((a, b) => b.input - a.input);
  const byModel = [...groupBy(calls, (c) => c.model)]
    .map(([model, cs]) => ({
      model,
      n: cs.length,
      input: sum(cs.map((c) => c.inputTokens)),
      output: sum(cs.map((c) => c.outputTokens)),
    }))
    .sort((a, b) => b.input - a.input);

  const cmds = o.cmds.filter((c) => c.at >= o.since && c.at <= o.until);
  const fullOf = (c: Cmd) => (c.full === null ? c.tokens : Math.ceil(c.full / 4));
  const byCmd = [...groupBy(cmds, (c) => c.cmd)]
    .map(([cmd, cs]) => ({
      cmd,
      n: cs.length,
      tokens: sum(cs.map((c) => c.tokens)),
      full: sum(cs.map(fullOf)),
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const bySite = [...groupBy(cmds, (c) => c.site)]
    .map(([site, cs]) => ({ site, cmds: cs.length, tokens: sum(cs.map((c) => c.tokens)) }))
    .sort((a, b) => b.tokens - a.tokens);

  const g = inputs.length ? grade(median) : null;
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  const line =
    g === null
      ? "no agent steps counted in this window"
      : `${g}: median ${median.toLocaleString("en-US")} input tokens per agent step; Playwright MCP sends ~${k(BASELINES.playwrightMcp)}, Stagehand ~${k(BASELINES.stagehand)} (${(BASELINES.playwrightMcp / median).toFixed(1)}x and ${(BASELINES.stagehand / median).toFixed(1)}x ours)`;
  return {
    since: o.since,
    until: o.until,
    steps: {
      counted: inputs.length,
      uncounted,
      medianInput: median,
      p90Input: pct(inputs, 90),
      meanOutput: outputs.length ? Math.round(sum(outputs) / outputs.length) : 0,
      source: fromLlm ? "llm" : oldSteps.length ? "steps" : "none",
    },
    calls: {
      n: calls.length,
      failed: calls.filter((c) => !c.ok).length,
      input: sum(calls.map((c) => c.inputTokens)),
      cached: sum(calls.map((c) => c.cachedTokens)),
      output: sum(calls.map((c) => c.outputTokens)),
      byPurpose,
      byModel,
    },
    answers: {
      cmds: cmds.length,
      tokens: sum(cmds.map((c) => c.tokens)),
      full: sum(cmds.map(fullOf)),
      byCmd,
      bySite,
    },
    verdict: { grade: g, perCall: inputs.length ? median : null, line },
  };
}

const n = (x: number): string => x.toLocaleString("en-US");
const col = (s: string | number, w: number, right = true): string => {
  const t = typeof s === "number" ? n(s) : s;
  return right ? t.padStart(w) : t.padEnd(w);
};

/** The report as a person reads it. */
export function formatTokenReport(r: TokenReport): string[] {
  const out: string[] = [`tokens ${r.since.slice(0, 10)} → ${r.until.slice(0, 10)}`, ""];
  out.push(`verdict: ${r.verdict.line}`);
  if (r.steps.counted)
    out.push(
      `agent steps: ${n(r.steps.counted)} counted (${r.steps.source === "llm" ? "call ledger" : "steps.jsonl"}), p90 ${n(r.steps.p90Input)} in, ~${n(r.steps.meanOutput)} out${r.steps.uncounted ? `; ${r.steps.uncounted} uncounted (driver did not report cache reads)` : ""}`,
    );
  out.push("");
  out.push(
    `model calls: ${n(r.calls.n)}${r.calls.failed ? ` (${r.calls.failed} failed)` : ""}, ${n(r.calls.input)} in (${n(r.calls.cached)} cached), ${n(r.calls.output)} out`,
  );
  if (r.calls.byPurpose.length) {
    out.push(
      `  ${col("purpose", 16, false)}${col("calls", 7)}${col("input", 11)}${col("cached", 11)}${col("output", 10)}${col("median in", 11)}`,
    );
    for (const p of r.calls.byPurpose)
      out.push(
        `  ${col(p.purpose, 16, false)}${col(p.n, 7)}${col(p.input, 11)}${col(p.cached, 11)}${col(p.output, 10)}${col(p.medianInput, 11)}`,
      );
  }
  if (r.calls.byModel.length > 1) {
    const w = Math.max(5, ...r.calls.byModel.map((m) => m.model.length)) + 2;
    out.push(
      `  ${col("model", w, false)}${col("calls", 7)}${col("input", 11)}${col("output", 10)}`,
    );
    for (const m of r.calls.byModel)
      out.push(`  ${col(m.model, w, false)}${col(m.n, 7)}${col(m.input, 11)}${col(m.output, 10)}`);
  }
  out.push("");
  const saved = r.answers.full ? r.answers.full / Math.max(1, r.answers.tokens) : 0;
  out.push(
    `explore answers: ${n(r.answers.cmds)} commands, ~${n(r.answers.tokens)} tokens to the caller${r.answers.full > r.answers.tokens ? `; whole-page answers would be ~${n(r.answers.full)} (${saved.toFixed(1)}x)` : ""}`,
  );
  if (r.answers.byCmd.length) {
    out.push(
      `  ${col("command", 12, false)}${col("n", 7)}${col("tokens", 10)}${col("per", 7)}${col("whole page", 12)}`,
    );
    for (const c of r.answers.byCmd.slice(0, 15))
      out.push(
        `  ${col(c.cmd, 12, false)}${col(c.n, 7)}${col(c.tokens, 10)}${col(Math.round(c.tokens / c.n), 7)}${col(c.full, 12)}`,
      );
  }
  if (r.answers.bySite.length > 1)
    out.push(
      `  by site: ${r.answers.bySite
        .slice(0, 8)
        .map((s) => `${s.site} ${n(s.tokens)}`)
        .join(", ")}`,
    );
  return out;
}
