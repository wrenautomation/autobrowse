/**
 * Site calls: every attempt at a `sites`/`desk` call, one line, kept for good.
 * Restate keeps a finished invocation about a day and the caps ledger only
 * metered reads for 14 days; this is the history success rates are read from.
 * A retried call is several lines under one `invocation`: the last says how
 * it ended. One file per month (`calls-2026-10.jsonl`), plain appends like
 * the model call ledger: several processes write and a line under 4 KB lands
 * whole. Never the input or the answer, only the route and the error's text.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SiteCallRow {
  at: string;
  /** `sites` (the box) or `desk` (the Mac). */
  service: string;
  site: string;
  /** `GET /r/{sub}/new` as asked, ids and all. */
  route: string;
  caller: string | null;
  invocation: string | null;
  /** 1 for the first try of this invocation in this process; a rerun after a crash starts at 1 again. */
  attempt: number;
  ok: boolean;
  /** The SiteError's status (400 the caller's mistake, 429 a cap); null for an unexpected throw. */
  status: number | null;
  /** True: the caller gets this error, nothing retries it. */
  terminal: boolean;
  error: string | null;
  ms: number;
  /** Imported from an older record (Restate's history, the caps ledger), not written live. */
  from?: "restate" | "caps";
}

export interface SiteCalls {
  record(row: SiteCallRow): void;
}

const ERROR_CHARS = 300;
const monthOf = (iso: string): string => iso.slice(0, 7);

export function fileSiteCalls(dir: string): SiteCalls {
  return {
    record(row) {
      const line = { ...row, error: row.error?.slice(0, ERROR_CHARS) ?? null };
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, `calls-${monthOf(row.at)}.jsonl`), `${JSON.stringify(line)}\n`, {
          mode: 0o600,
        });
      } catch {
        // A full disk never fails the call it records.
      }
    },
  };
}

export function memorySiteCalls(): SiteCalls & { rows: SiteCallRow[] } {
  const rows: SiteCallRow[] = [];
  return { rows, record: (r) => rows.push(r) };
}

/** Rows since `since` (ISO), oldest first, from the month files that can hold them. */
export function readSiteCalls(dir: string, since: string): SiteCallRow[] {
  if (!existsSync(dir)) return [];
  const from = monthOf(since);
  const out: SiteCallRow[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^calls-(\d{4}-\d{2})\.jsonl$/.exec(f);
    if (!m || (m[1] as string) < from) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as SiteCallRow;
        if (row.at >= since) out.push(row);
      } catch {
        // A torn line from a crash mid-write is skipped, not fatal.
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** One line per invocation: its last attempt, and how many it took. Rows without an invocation stand alone. */
export function settledCalls(rows: SiteCallRow[]): (SiteCallRow & { attempts: number })[] {
  const by = new Map<string, SiteCallRow & { attempts: number }>();
  rows.forEach((r, i) => {
    const key = r.invocation ?? `#${i}`;
    const had = by.get(key);
    by.set(key, { ...r, attempts: (had?.attempts ?? 0) + 1 });
  });
  return [...by.values()];
}
