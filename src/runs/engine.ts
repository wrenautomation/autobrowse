/**
 * Engine runs in one process (`runFlow` on memory effects: legs, compiled runs, `do`): one line
 * per run as it stops, kept for good. The Restate run object has its registry; these have this.
 * One file per month (`engine-2026-10.jsonl`), plain appends like the flow ledger. Never the
 * input or a step's answer: a done step keeps its name and status, a failed one its error's text.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStatusView } from "../engine/object.js";
import { compareRows, type ListQuery, pageOf, type RunRow } from "../engine/rows.js";
import type { OpenGate, Results, RunStatus, StepStatus } from "../engine/run.js";
import { redactText } from "../recorder/redact.js";

export interface EngineStepRow {
  name: string;
  status: string;
  at: string;
  /** Only when it did not end done or skipped: the error, masked and cut. */
  detail?: string;
  screenshot?: string;
  trace?: string;
}

export interface EngineRunRow {
  workflow: string;
  /** The durable call it ran under (invocation id + step), else a fresh id. */
  key: string;
  site: string | null;
  startedAt: string;
  endedAt: string;
  ms: number;
  status: RunStatus;
  gate: string | null;
  steps: EngineStepRow[];
}

export interface EngineRuns {
  record(row: EngineRunRow): void;
}

const DETAIL_CHARS = 300;
const monthOf = (iso: string): string => iso.slice(0, 7);

/** A run's steps as the ledger keeps them. */
export function stepRows(results: Results, gate: OpenGate | null): EngineStepRow[] {
  return Object.entries(results).flatMap(([name, r]) => {
    if (!r) return [];
    const kept = r.status === "done" || r.status === "skipped" || r.status === "planned";
    const artifacts = gate?.step === name ? gate : r;
    return [
      {
        name,
        status: r.status,
        at: r.at,
        ...(kept ? {} : { detail: redactText(r.detail).slice(0, DETAIL_CHARS) }),
        ...(artifacts.screenshot ? { screenshot: artifacts.screenshot } : {}),
        ...(artifacts.trace ? { trace: artifacts.trace } : {}),
      },
    ];
  });
}

export function fileEngineRuns(dir: string): EngineRuns {
  return {
    record(row) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(
          join(dir, `engine-${monthOf(row.startedAt)}.jsonl`),
          `${JSON.stringify(row)}\n`,
          {
            mode: 0o600,
          },
        );
      } catch {
        // A full disk never fails the run it records.
      }
    },
  };
}

export function memoryEngineRuns(): EngineRuns & { rows: EngineRunRow[] } {
  const rows: EngineRunRow[] = [];
  return { rows, record: (r) => rows.push(r) };
}

/** Rows started since `since` (ISO), oldest first. */
export function readEngineRuns(dir: string, since: string): EngineRunRow[] {
  if (!existsSync(dir)) return [];
  const from = monthOf(since);
  const out: EngineRunRow[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^engine-(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (!m || (m[1] as string) < from) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as EngineRunRow;
        if (row.startedAt >= since) out.push(row);
      } catch {
        // torn
      }
    }
  }
  return out;
}

/** The registry's row for a ledger run: the Runs page lists both the same way. */
export const listRow = (r: EngineRunRow): RunRow => ({
  workflow: r.workflow,
  key: r.key,
  startedAt: r.startedAt,
  updatedAt: r.endedAt,
  status: r.status,
  gate: r.gate,
  lastStep: r.steps.at(-1)?.name ?? null,
});

/** How far back the Runs page reads the ledger. */
const LIST_DAYS = 31;

export interface EngineRunsView {
  /** Newest first, as the registry pages (`engine/rows.ts`). */
  list(q: ListQuery): RunRow[];
  /** The run as the run object answers `status`; null when the ledger has no such run. */
  status(workflow: string, key: string): RunStatusView | null;
}

/** The ledger for the Runs page: read per call, the last month only. */
export function engineRunsView(dir: string, now: () => number = Date.now): EngineRunsView {
  const rows = () => readEngineRuns(dir, new Date(now() - LIST_DAYS * 86_400_000).toISOString());
  return {
    list: (q) => pageOf(rows().map(listRow), q),
    status(workflow, key) {
      const r = rows().findLast((x) => x.workflow === workflow && x.key === key);
      if (!r) return null;
      const results = Object.fromEntries(
        r.steps.map((s) => [
          s.name,
          {
            status: s.status as StepStatus,
            detail: s.detail ?? s.status,
            at: s.at,
            ...(s.screenshot ? { screenshot: s.screenshot } : {}),
            ...(s.trace ? { trace: s.trace } : {}),
          },
        ]),
      );
      const last = r.steps.at(-1);
      const gate: OpenGate | null =
        r.gate && last
          ? {
              name: r.gate as OpenGate["name"],
              step: last.name,
              prompt: last.detail ?? r.gate,
              openedAt: last.at,
              ...(last.screenshot ? { screenshot: last.screenshot } : {}),
              ...(last.trace ? { trace: last.trace } : {}),
            }
          : null;
      return {
        workflow,
        key,
        plan: null,
        gate,
        paused: false,
        outcome: { status: r.status, results, memo: {} },
      };
    },
  };
}

/** Two pages newest first, one page of both: each side already gave `limit` rows after the cursor. */
export function mergePages(a: RunRow[], b: RunRow[], limit: number): RunRow[] {
  return [...a, ...b].sort(compareRows).slice(0, limit);
}
