/**
 * Secrets out of every trace already written: this disk's, in place, and the backup's
 * (designs/2026-10-24-trace-secrets.md). Nothing is deleted. A changed local trace
 * goes back to its own key through the push; a trace only in the backup is fetched,
 * scrubbed and put back under its key. A ledger line per trace done, so a stopped
 * run goes on where it stopped: each fetch from the backup is billed.
 */
import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { scrubSecretsFile } from "../browser/trace-secrets.js";
import type { ShipReport } from "./ship.js";
import { type TraceOptions, type TraceStore, traces } from "./traces.js";

export interface ScrubTotals {
  traces: number;
  changed: number;
  masked: number;
  leaks: number;
  /** Bytes fetched from the backup. */
  fetched: number;
  failed: number;
}

export interface ScrubReport {
  local: ScrubTotals;
  backup: ScrubTotals;
  /** The push of changed local traces, when one ran: a refusal leaves them for the next push. */
  pushed: ShipReport | null;
}

const totals = (): ScrubTotals => ({
  traces: 0,
  changed: 0,
  masked: 0,
  leaks: 0,
  fetched: 0,
  failed: 0,
});

export async function scrubKeptTraces(
  o: TraceOptions & {
    store: TraceStore | null;
    /** One line per trace done: `local<TAB>ledger line` or `backup<TAB>key`. */
    doneFile: string;
    /** Where a backup trace waits while it is scrubbed: never a trace folder. */
    workDir: string;
    /** Under the store's prefix: `traces/`, every machine's. */
    under: string;
    /** Back to the backup: the push, so a changed local trace replaces its kept copy. */
    push: () => Promise<ShipReport>;
    backup: boolean;
    log?: (line: string) => void;
  },
): Promise<ScrubReport> {
  const done = new Set((await readFile(o.doneFile, "utf8").catch(() => "")).split("\n"));
  const mark = (line: string) => appendFile(o.doneFile, `${line}\n`);
  const report: ScrubReport = { local: totals(), backup: totals(), pushed: null };
  const failed = (what: string, err: unknown) =>
    o.log?.(
      `${what}: not scrubbed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`,
    );
  const add = (t: ScrubTotals, r: { changed: boolean; masked: number; leaks: number }) => {
    t.traces++;
    if (r.changed) t.changed++;
    t.masked += r.masked;
    t.leaks += r.leaks;
  };

  const local = await traces(o);
  for (const t of local) {
    if (done.has(`local\t${t.line}`)) continue;
    try {
      add(report.local, await scrubSecretsFile(t.path));
      const s = await stat(t.path);
      await mark(`local\t${t.key}\t${s.size}\t${Math.trunc(s.mtimeMs)}`);
    } catch (err) {
      report.local.failed++;
      failed(t.key, err);
    }
  }
  // Always: a push an earlier run lost (a dropped connection) still holds changed traces.
  if (o.store) report.pushed = await o.push();
  if (!o.backup || !o.store) return report;

  const here = new Set(local.map((t) => t.key));
  await mkdir(o.workDir, { recursive: true });
  const work = join(o.workDir, "trace.zip");
  for await (const { key, size } of o.store.keys(o.under)) {
    if (!key.endsWith(".zip") || here.has(key) || done.has(`backup\t${key}`)) continue;
    try {
      await o.store.getFile(key, work);
      report.backup.fetched += size;
      const r = await scrubSecretsFile(work);
      add(report.backup, r);
      if (r.changed) await o.store.putFile(key, work, (await stat(work)).size);
      await mark(`backup\t${key}`);
    } catch (err) {
      report.backup.failed++;
      failed(key, err);
    } finally {
      await rm(work, { force: true });
    }
    const b = report.backup;
    if (b.traces % 100 === 0)
      o.log?.(
        `backup: ${b.traces} scrubbed, ${b.changed} changed, ${(b.fetched / 1e9).toFixed(1)} GB fetched`,
      );
  }
  return report;
}

export function scrubWording(r: ScrubReport): string[] {
  const line = (where: string, t: ScrubTotals) =>
    `${where}: ${t.traces} scrubbed, ${t.changed} changed, ${t.masked} values masked, ${t.leaks} left${t.failed ? `, ${t.failed} failed` : ""}${t.fetched ? `, ${(t.fetched / 1e9).toFixed(2)} GB fetched` : ""}`;
  return [line("this disk", r.local), line("backup", r.backup)];
}
