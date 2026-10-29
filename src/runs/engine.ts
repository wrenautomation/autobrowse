/**
 * Engine runs in one process (`runFlow` on memory effects: legs, compiled runs, `do`): one line
 * per run as it stops, kept for good. The Restate run object has its registry; these have this.
 * One file per month (`engine-2026-10.jsonl`), plain appends like the flow ledger. Never the
 * input or a step's answer: a done step keeps its name and status, a failed one its error's text.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { RunStatusView } from "../engine/object.js";
import { compareRows, type ListQuery, pageOfOrdered, type RunRow } from "../engine/rows.js";
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
  // A gate a step asked for leaves no result: the step shows as waiting on it.
  const asked =
    gate && !results[gate.step]
      ? [
          {
            name: gate.step,
            status: "waiting",
            at: gate.openedAt,
            detail: redactText(gate.prompt).slice(0, DETAIL_CHARS),
          },
        ]
      : [];
  return [
    ...Object.entries(results).flatMap(([name, r]) => {
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
    }),
    ...asked,
  ];
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

type MonthFile = { mtimeMs: number; size: number; rows: EngineRunRow[] };

const parse = (text: string): EngineRunRow[] =>
  text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as EngineRunRow];
    } catch {
      return []; // torn
    }
  });

function tail(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Rows started since `since` (ISO), oldest first, and a stamp that moves when a file changes. A
 * month file parses again only when it changed.
 */
export function engineRunsReader(
  dir: string,
): (since: string) => { rows: EngineRunRow[]; stamp: string } {
  const cache = new Map<string, MonthFile>();
  return (since) => {
    if (!existsSync(dir)) return { rows: [], stamp: "" };
    const from = monthOf(since);
    const out: EngineRunRow[] = [];
    let stamp = "";
    for (const f of readdirSync(dir).sort()) {
      const m = /^engine-(\d{4}-\d{2})\.jsonl$/.exec(f);
      if (!m || (m[1] as string) < from) continue;
      const path = join(dir, f);
      const { mtimeMs, size } = statSync(path);
      let got = cache.get(f);
      if (!got || got.mtimeMs !== mtimeMs || got.size !== size) {
        // appends only: a grown file reads its new tail; a shrunk one reads again. Up to the last
        // newline: a line half written comes in whole next time.
        const grown = got && size > got.size ? got : null;
        const read = grown ? tail(path, grown.size, size) : readFileSync(path, "utf8");
        const text = read.slice(0, read.lastIndexOf("\n") + 1);
        got = {
          mtimeMs,
          size: (grown?.size ?? 0) + Buffer.byteLength(text),
          rows: [...(grown?.rows ?? []), ...parse(text)],
        };
        cache.set(f, got);
      }
      stamp += `${f}:${mtimeMs}:${size};`;
      for (const row of got.rows) if (row.startedAt >= since) out.push(row);
    }
    return { rows: out, stamp };
  };
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

/** The ledger for the Runs page: the last month only. */
export function engineRunsView(dir: string, now: () => number = Date.now): EngineRunsView {
  const read = engineRunsReader(dir);
  const rows = () => read(new Date(now() - LIST_DAYS * 86_400_000).toISOString()).rows;
  // sorted once per change of a file or the day; 30k rows: 69 ms cold, 9 ms after a write, 1 ms warm
  let listed: { stamp: string; rows: RunRow[] } | null = null;
  return {
    list(q) {
      const since = new Date(now() - LIST_DAYS * 86_400_000).toISOString();
      const got = read(since);
      const stamp = `${got.stamp}${since.slice(0, 10)}`;
      if (listed?.stamp !== stamp) {
        // A retried call writes a row per try under one key: the last one stands.
        const last = new Map(got.rows.map((r) => [`${r.workflow}/${r.key}`, listRow(r)]));
        listed = { stamp, rows: [...last.values()].sort(compareRows) };
      }
      return pageOfOrdered(listed.rows, q);
    },
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
