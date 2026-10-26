/**
 * Old Playwright traces as training steps (designs/2026-10-26-run-observations.md), beside the
 * explore runs' `explored steps`. One step per page act (a goto, a click, a key, a mouse move);
 * the frames it was chosen on and led to are named by their path inside the trace, which stays
 * in TRACES_TO: nothing is copied. Typed text is masked like a run's.
 */
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { salvageZip } from "../browser/trace-secrets.js";
import { redactText } from "../recorder/redact.js";
import { type TraceOptions, type TraceStore, traces } from "./traces.js";

export interface TraceStep {
  /** The trace's key in TRACES_TO. */
  episode: string;
  source: "trace";
  step: number;
  /** ms since the trace's first event. */
  t: number;
  obs: { frame?: string };
  action: {
    method: string;
    selector?: string;
    url?: string;
    value?: string;
    key?: string;
    x?: number;
    y?: number;
  };
  next: { frame?: string };
  out: { ok: boolean; error?: string };
  /** A trace is kept when a flow failed: the episode's label once any act errs. */
  outcome?: "failed";
}

/** What a hand does on a page; the rest (route handlers, reads, waits) is the runner's own. */
const ACTS = new Set(
  "goto click dblclick tap fill type press keyboardPress keyboardType keyboardInsertText mouseClick mouseMove mouseDown mouseUp mouseWheel selectOption check uncheck setInputFiles hover dragTo setChecked reload goBack goForward".split(
    " ",
  ),
);

type Ev = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
/** `{ [k]: v }` when there is a value, else nothing: a step carries no empty keys. */
const some = <K extends string, V>(k: K, v: V | undefined) =>
  (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };

export function traceSteps(zip: Uint8Array, episode: string): TraceStep[] {
  let files: Record<string, Uint8Array> | null;
  try {
    files = unzipSync(zip);
  } catch {
    files = salvageZip(zip);
  }
  if (!files) return [];
  const events: Ev[] = [];
  for (const [name, body] of Object.entries(files))
    if (name.endsWith(".trace"))
      for (const line of strFromU8(body).split("\n")) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as Ev);
        } catch {
          // a cut line
        }
      }
  const frames = events
    .filter((e) => e.type === "screencast-frame" && str(e.file) && num(e.timestamp) !== undefined)
    .map((e) => ({ file: e.file as string, at: e.timestamp as number }))
    .sort((a, b) => a.at - b.at);
  const ends = new Map<string, Ev>();
  for (const e of events) if (e.type === "after" && str(e.callId)) ends.set(e.callId as string, e);
  const t0 = Math.min(
    ...events.map((e) => num(e.startTime) ?? num(e.timestamp) ?? Number.POSITIVE_INFINITY),
  );
  const before = (at: number) => frames.filter((f) => f.at <= at).at(-1)?.file;
  const after = (at: number) => frames.find((f) => f.at >= at)?.file;
  const out: TraceStep[] = [];
  for (const e of events) {
    if (e.type !== "before" || !ACTS.has(str(e.method) ?? "")) continue;
    const start = num(e.startTime) ?? 0;
    const end = ends.get(str(e.callId) ?? "");
    const p = (e.params ?? {}) as Ev;
    const typed = str(p.value) ?? str(p.text);
    const err = end?.error as { message?: unknown } | undefined;
    const prior = before(start);
    const next = after(num(end?.endTime) ?? start);
    out.push({
      episode,
      source: "trace",
      step: out.length,
      t: Number.isFinite(t0) ? Math.round(start - t0) : 0,
      obs: prior ? { frame: prior } : {},
      action: {
        method: e.method as string,
        ...some("selector", str(p.selector)),
        ...some("url", str(p.url)),
        ...some("value", typed === undefined ? undefined : redactText(typed)),
        ...some("key", str(p.key)),
        ...some("x", num(p.x)),
        ...some("y", num(p.y)),
      },
      next: next ? { frame: next } : {},
      out: err
        ? { ok: false, error: redactText(String(err.message ?? "")).slice(0, 200) }
        : { ok: true },
    });
  }
  if (out.some((s) => !s.out.ok)) for (const s of out) s.outcome = "failed";
  return out;
}

export interface TraceStepsReport {
  traces: number;
  steps: number;
  /** Bytes fetched from the backup. */
  fetched: number;
  failed: number;
}

/** Every trace on this disk, and with `backup` each one only in TRACES_TO, into one JSONL file. */
export async function keptTraceSteps(
  o: TraceOptions & {
    store: TraceStore | null;
    under: string;
    workDir: string;
    backup: boolean;
    out: string;
  },
): Promise<TraceStepsReport> {
  const report: TraceStepsReport = { traces: 0, steps: 0, fetched: 0, failed: 0 };
  await writeFile(o.out, "", { mode: 0o600 });
  const add = async (zip: Uint8Array, key: string) => {
    const steps = traceSteps(zip, key);
    report.traces++;
    report.steps += steps.length;
    if (steps.length)
      await appendFile(o.out, `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`);
  };
  const local = await traces(o);
  for (const t of local)
    await readFile(t.path)
      .then((zip) => add(zip, t.key))
      .catch(() => void report.failed++);
  if (!o.backup || !o.store) return report;
  const here = new Set(local.map((t) => t.key));
  await mkdir(o.workDir, { recursive: true });
  const work = join(o.workDir, "trace.zip");
  for await (const { key, size } of o.store.keys(o.under)) {
    if (!key.endsWith(".zip") || here.has(key)) continue;
    try {
      await o.store.getFile(key, work);
      report.fetched += size;
      await add(await readFile(work), key);
    } catch {
      report.failed++;
    } finally {
      await rm(work, { force: true });
    }
  }
  return report;
}
