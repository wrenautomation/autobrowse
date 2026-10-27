/**
 * One agent run as JSON (`autobrowse agent --json`): what a benchmark
 * harness reads back (designs/2026-10-27-bench.md). Each step is also one line of
 * text, the trajectory a judge reads; a read's text rides along, since the
 * answer the judge checks is often in it.
 */
import type { LlmUsage } from "../llm/types.js";
import type { StepRecord } from "./explorer.js";

export interface RunJson {
  goal: string;
  /** Null while the run goes on: a run killed by a timeout leaves its steps and no verdict. */
  achieved: boolean | null;
  summary: string | null;
  steps: Array<{
    n: number;
    thought: string | null;
    cmd: string;
    error: string | null;
    url: string;
    ms: number;
    line: string;
  }>;
  /** A screenshot before each look and one at the end, in order. */
  shots: string[];
  usage: LlmUsage;
  ms: number;
}

/** What a step's result adds to its line: the text a read or records act took. */
const RESULT_CHARS = 600;

function stepLine(s: StepRecord): string {
  if (!s.step) return `Step ${s.n}: unparsable reply${s.error ? ` (${s.error})` : ""}`;
  const { cmd, ...args } = s.step.action;
  const kept =
    cmd === "read" || cmd === "records"
      ? ` -> ${JSON.stringify(s.result).slice(0, RESULT_CHARS)}`
      : "";
  const outcome = s.error ? ` FAILED: ${s.error}` : kept;
  return `Step ${s.n} at ${s.url}: ${s.step.thought}\n  ${cmd} ${JSON.stringify(args)}${outcome}`;
}

export function runJson(
  goal: string,
  steps: readonly StepRecord[],
  shots: readonly string[],
  startedAt: number,
  end?: { achieved: boolean; summary: string; usage: LlmUsage },
): RunJson {
  const usage = end?.usage ?? {
    inputTokens: steps.reduce((a, s) => a + s.usage.inputTokens, 0),
    outputTokens: steps.reduce((a, s) => a + s.usage.outputTokens, 0),
  };
  return {
    goal,
    achieved: end?.achieved ?? null,
    summary: end?.summary ?? null,
    steps: steps.map((s) => ({
      n: s.n,
      thought: s.step?.thought ?? null,
      cmd: s.step?.action.cmd ?? "invalid",
      error: s.error,
      url: s.url,
      ms: s.ms,
      line: stepLine(s),
    })),
    shots: [...shots],
    usage,
    ms: Date.now() - startedAt,
  };
}
