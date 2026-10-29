/**
 * Flow runs: one line per `flowRunner` run, success or not, kept for good.
 * The failure record (`*.failure.json`) says why one run broke; this says how
 * often runs break, where, and what they cost. One file per month
 * (`flows-2026-10.jsonl`), plain appends like the model call ledger. Never
 * the input or what the page showed, only the goal and the error's text.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FlowOutcome = "ok" | "human" | "interrupted" | "failed";

export interface FlowRunRow {
  site: string;
  flow: string;
  startedAt: string;
  endedAt: string;
  ms: number;
  outcome: FlowOutcome;
  /** An irreversible act started: a failure after it may have gone through. */
  submitted: boolean;
  /** The goal of the last act or read: on a failure, the step that broke. */
  goal: string | null;
  error: string | null;
  acts: number;
  /** Whole captcha solves tried; `captchaSolved` null when no captcha was met. */
  captchaTries: number;
  captchaSolved: boolean | null;
  /** Counted model calls made inside the run (`countedLlm`), the captcha's eyes and repairs included. */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The human motions' seed: `AUTOBROWSE_SEED=<it>` replays them on the same page. Absent: no browser opened. */
  seed?: number;
}

export interface FlowRuns {
  record(row: FlowRunRow): void;
}

const ERROR_CHARS = 300;
const monthOf = (iso: string): string => iso.slice(0, 7);

export function fileFlowRuns(dir: string): FlowRuns {
  return {
    record(row) {
      const line = { ...row, error: row.error?.slice(0, ERROR_CHARS) ?? null };
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(
          join(dir, `flows-${monthOf(row.startedAt)}.jsonl`),
          `${JSON.stringify(line)}\n`,
          { mode: 0o600 },
        );
      } catch {
        // A full disk never fails the run it records.
      }
    },
  };
}

export function memoryFlowRuns(): FlowRuns & { rows: FlowRunRow[] } {
  const rows: FlowRunRow[] = [];
  return { rows, record: (r) => rows.push(r) };
}

/** Rows started since `since` (ISO), oldest first, from the month files that can hold them. */
export function readFlowRuns(dir: string, since: string): FlowRunRow[] {
  if (!existsSync(dir)) return [];
  const from = monthOf(since);
  const out: FlowRunRow[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^flows-(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (!m || (m[1] as string) < from) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as FlowRunRow;
        if (row.startedAt >= since) out.push(row);
      } catch {
        // torn
      }
    }
  }
  return out;
}

export interface FlowGroup {
  runs: number;
  ok: number;
  /** Runs that did not end ok, over all runs. */
  failureRate: number;
  p50Ms: number;
  p95Ms: number;
  inputTokens: number;
  outputTokens: number;
}

export interface FlowRunReport extends FlowGroup {
  /** By `site/flow`, most failures first. */
  byFlow: (FlowGroup & { flow: string })[];
  bySite: (FlowGroup & { site: string })[];
  /** Failed runs by outcome and the step that broke, most first. */
  byFailure: { outcome: FlowOutcome; goal: string | null; n: number; example: string | null }[];
  captcha: { runs: number; tries: number; solved: number };
  /** UTC days, oldest first. */
  byDay: (FlowGroup & { day: string })[];
}

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
};

function groupOf(rows: readonly FlowRunRow[]): FlowGroup {
  const ok = rows.filter((r) => r.outcome === "ok").length;
  const ms = rows.map((r) => r.ms);
  return {
    runs: rows.length,
    ok,
    failureRate: rows.length ? (rows.length - ok) / rows.length : 0,
    p50Ms: pct(ms, 50),
    p95Ms: pct(ms, 95),
    inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
  };
}

function groupsBy<K extends string>(
  rows: readonly FlowRunRow[],
  name: K,
  key: (r: FlowRunRow) => string,
): (FlowGroup & Record<K, string>)[] {
  const m = new Map<string, FlowRunRow[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return [...m].map(([k, rs]) => ({ [name]: k, ...groupOf(rs) }) as FlowGroup & Record<K, string>);
}

export function flowRunReport(rows: readonly FlowRunRow[]): FlowRunReport {
  const fails = (g: FlowGroup) => g.runs - g.ok;
  const failures = new Map<string, FlowRunReport["byFailure"][number]>();
  for (const r of rows) {
    if (r.outcome === "ok") continue;
    const k = `${r.outcome}\u0000${r.goal ?? ""}`;
    const f = failures.get(k) ?? { outcome: r.outcome, goal: r.goal, n: 0, example: r.error };
    f.n++;
    failures.set(k, f);
  }
  const met = rows.filter((r) => r.captchaSolved !== null);
  return {
    ...groupOf(rows),
    byFlow: groupsBy(rows, "flow", (r) => `${r.site}/${r.flow}`).sort(
      (a, b) => fails(b) - fails(a),
    ),
    bySite: groupsBy(rows, "site", (r) => r.site).sort((a, b) => fails(b) - fails(a)),
    byFailure: [...failures.values()].sort((a, b) => b.n - a.n),
    captcha: {
      runs: met.length,
      tries: met.reduce((a, r) => a + r.captchaTries, 0),
      solved: met.filter((r) => r.captchaSolved).length,
    },
    byDay: groupsBy(rows, "day", (r) => r.startedAt.slice(0, 10)).sort((a, b) =>
      a.day.localeCompare(b.day),
    ),
  };
}

const rate = (r: number) => `${(r * 100).toFixed(r && r < 0.1 ? 1 : 0)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function formatFlowRunReport(r: FlowRunReport): string[] {
  if (!r.runs) return ["flow runs", "  none in this window"];
  const row = (name: string, g: FlowGroup) =>
    `    ${name.padEnd(28)} ${String(g.runs).padStart(5)} ${rate(g.failureRate).padStart(6)} ${secs(g.p50Ms).padStart(7)} ${secs(g.p95Ms).padStart(7)} ${String(g.inputTokens + g.outputTokens).padStart(9)}`;
  const out = [
    "flow runs",
    `  ${r.runs} runs, ${r.runs - r.ok} failed (${rate(r.failureRate)}), p50 ${secs(r.p50Ms)}, p95 ${secs(r.p95Ms)}, ${r.inputTokens} in / ${r.outputTokens} out tokens`,
    `  captcha: met in ${r.captcha.runs} runs, ${r.captcha.solved} solved, ${r.captcha.tries} tries`,
    "  by flow                       runs  fail     p50     p95    tokens",
    ...r.byFlow.map((g) => row(g.flow, g)),
  ];
  if (r.byFailure.length) {
    out.push("  why runs failed");
    for (const f of r.byFailure.slice(0, 10))
      out.push(
        `    ${f.outcome.padEnd(11)} ${String(f.n).padStart(4)}  ${f.goal ?? "(before any act)"}: ${(f.example ?? "").slice(0, 100)}`,
      );
  }
  return out;
}
