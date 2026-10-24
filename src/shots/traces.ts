/**
 * Playwright traces (a failed flow's `<stamp>.zip`) are the fullest record of a run, and the
 * largest: field values, network bodies, a frame per step. They are kept for good in a backup
 * (`TRACES_TO`: an S3 bucket, or a folder such as an encrypted drive), then swept off this disk
 * once they are older than `TRACES_KEEP_DAYS`. A trace is swept only when the ledger shows this
 * exact file (key, size, mtime) in the backup; with no backup set, nothing is swept.
 */
import { appendFile, copyFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { ShipReport } from "./ship.js";

/** Where traces are kept. One file at a time, streamed: a trace can be hundreds of MB. */
export interface TraceStore {
  /** Names the target in messages: `s3://bucket/prefix`, a folder. */
  where: string;
  putFile(key: string, path: string, size: number): Promise<void>;
}

/** A folder that holds traces: autobrowse's own artifacts, or a caller's `artifactsDir`. */
export interface TraceDir {
  /** The key segment: `artifacts`, `internships-artifacts`. */
  name: string;
  dir: string;
}

export interface TraceOptions {
  dirs: TraceDir[];
  /** One line per kept trace: `key<TAB>size<TAB>mtimeMs`. */
  ledgerFile: string;
  /** Key start: the owner's segment, then `traces/<machine>/`. */
  prefix: string;
}

export interface SweepReport {
  removed: number;
  bytes: number;
  /** Old enough, but not in the backup yet: kept. */
  unkept: number;
}

/** A caller's folder gets its parent's name too, so two `artifacts` folders never share keys. */
export const traceDirName = (dir: string, own: boolean): string =>
  own ? "artifacts" : `${basename(dirname(dir))}-${basename(dir)}`;

async function* zips(dir: string, depth = 0): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    // A watched run keeps its trace one folder down (`<run>/trace.zip`).
    if (e.isDirectory() && depth === 0) yield* zips(p, 1);
    else if (e.isFile() && e.name.endsWith(".zip")) yield p;
  }
}

async function traces(o: TraceOptions) {
  const out: Array<{ path: string; key: string; line: string; size: number; mtime: number }> = [];
  for (const d of o.dirs)
    for await (const path of zips(d.dir)) {
      const s = await stat(path).catch(() => null);
      if (!s) continue;
      const key = [`${o.prefix}${d.name}`, ...relative(d.dir, path).split(sep)].join("/");
      out.push({
        path,
        key,
        line: `${key}\t${s.size}\t${Math.trunc(s.mtimeMs)}`,
        size: s.size,
        mtime: s.mtimeMs,
      });
    }
  return out.sort((a, b) => a.mtime - b.mtime);
}

async function kept(file: string): Promise<Set<string>> {
  const text = await readFile(file, "utf8").catch(() => "");
  return new Set(text.split("\n").filter(Boolean));
}

/** Copy every trace not yet kept, oldest first; each one is written to the ledger once stored. */
export async function backupTraces(
  o: TraceOptions & { store: TraceStore; dry?: boolean },
): Promise<ShipReport> {
  const done = await kept(o.ledgerFile);
  const todo = (await traces(o)).filter((t) => !done.has(t.line));
  const report: ShipReport = { shipped: 0, bytes: 0, pending: 0, unreadable: [], refused: null };
  if (o.dry) return { ...report, pending: todo.length };
  for (const [i, t] of todo.entries()) {
    try {
      await o.store.putFile(t.key, t.path, t.size);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // The file went (swept, moved) between the list and the copy: skip it.
      if (code === "ENOENT") {
        report.unreadable.push(t.key);
        continue;
      }
      report.refused = err instanceof Error ? err.message : String(err);
      report.pending = todo.length - i;
      break;
    }
    await appendFile(o.ledgerFile, `${t.line}\n`);
    report.shipped++;
    report.bytes += t.size;
  }
  return report;
}

/** Remove traces older than `keepDays` that the ledger shows kept, byte for byte. */
export async function sweepTraces(
  o: TraceOptions & { keepDays: number; now: Date; dry?: boolean },
): Promise<SweepReport> {
  const done = await kept(o.ledgerFile);
  const before = o.now.getTime() - o.keepDays * 86_400_000;
  const report: SweepReport = { removed: 0, bytes: 0, unkept: 0 };
  for (const t of await traces(o)) {
    if (t.mtime >= before) continue;
    if (!done.has(t.line)) {
      report.unkept++;
      continue;
    }
    if (!o.dry) await unlink(t.path).catch(() => {});
    report.removed++;
    report.bytes += t.size;
  }
  return report;
}

/** A folder target: an encrypted drive, a synced folder. */
export function dirTraceStore(root: string): TraceStore {
  return {
    where: root,
    async putFile(key, path) {
      const to = join(root, ...key.split("/"));
      await mkdir(dirname(to), { recursive: true });
      await copyFile(path, to);
    },
  };
}

export function traceWording(r: ShipReport, where: string): string[] {
  const mb = (r.bytes / 1024 / 1024).toFixed(1);
  const lines: string[] = [];
  if (r.shipped) lines.push(`kept ${r.shipped} traces (${mb} MB) in ${where}`);
  if (r.refused) lines.push(`${where} refused: ${r.refused}; ${r.pending} left, kept next run`);
  else if (r.pending) lines.push(`${r.pending} traces to keep`);
  if (r.unreadable.length) lines.push(`${r.unreadable.length} went before the copy: skipped`);
  if (!lines.length) lines.push("no new traces");
  return lines;
}

export function sweepWording(r: SweepReport, keepDays: number, dry: boolean): string[] {
  const mb = (r.bytes / 1024 / 1024).toFixed(1);
  const lines = [
    `${dry ? "would remove" : "removed"} ${r.removed} traces (${mb} MB) older than ${keepDays} days`,
  ];
  if (r.unkept) lines.push(`${r.unkept} old traces not in the backup yet: kept`);
  return lines;
}
