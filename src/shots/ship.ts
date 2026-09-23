/**
 * Screenshots are signal: what a page looked like when a flow failed, and
 * every step of a recording or an explore. They are written to local disk
 * (the box's volume, a laptop), which one lost machine loses. `shipShots`
 * copies them to a bucket with the text that explains them (the aria tree,
 * the failure JSON, a recording's manifest and journal).
 *
 * One file is one unit: shipped, then written to the ledger, so a stop
 * mid-way resumes where it left off. A file that changes (a manifest
 * rewritten) ships again. Trace zips stay local: they hold network bodies.
 */
import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

export interface ShotRoot {
  /** The key segment: `artifacts`, `recordings`. */
  name: string;
  dir: string;
  /** Which files under it ship (path relative to `dir`). */
  keep: (rel: string) => boolean;
}

/** Where shots go. One adapter names the vendor (S3, or R2 by endpoint). */
export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface ShipOptions {
  roots: ShotRoot[];
  store: BlobStore;
  /** One line per shipped file: `key<TAB>size<TAB>mtimeMs`. */
  ledgerFile: string;
  /** First key segment: which machine took it (`box`, a laptop's name). */
  machine: string;
  dry?: boolean;
}

export interface ShipReport {
  shipped: number;
  bytes: number;
  /** Not shipped: the store refused (the run stops at the first refusal), or `dry`. */
  pending: number;
  /** Files that could not be read; skipped, never blocking the rest. */
  unreadable: string[];
  /** Why the store refused, when it did. */
  refused: string | null;
}

const IMAGES = new Set([".png", ".jpg", ".jpeg"]);
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".txt": "text/plain; charset=utf-8",
};

/** A flow's failure: the PNG, its aria tree and its failure JSON. */
export const keepArtifact = (rel: string): boolean =>
  IMAGES.has(extname(rel)) || rel.endsWith(".aria.txt") || rel.endsWith(".failure.json");

/** A recording or explore: its screenshots, manifest, summary and journals. */
export const keepRecording = (rel: string): boolean =>
  IMAGES.has(extname(rel)) ||
  rel.endsWith("manifest.json") ||
  rel.endsWith("summary.json") ||
  rel.endsWith(".jsonl");

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function shippedSet(file: string): Promise<Set<string>> {
  const text = await readFile(file, "utf8").catch(() => "");
  return new Set(text.split("\n").filter(Boolean));
}

/** Every shot not yet in the bucket, oldest first. */
async function pendingShots(o: ShipOptions) {
  const done = await shippedSet(o.ledgerFile);
  const out: Array<{ path: string; key: string; line: string; size: number; mtime: number }> = [];
  for (const root of o.roots) {
    for await (const path of walk(root.dir)) {
      const rel = relative(root.dir, path);
      if (!root.keep(rel)) continue;
      const s = await stat(path).catch(() => null);
      if (!s || s.size > MAX_BYTES) continue;
      const key = [o.machine, root.name, ...rel.split(sep)].join("/");
      const line = `${key}\t${s.size}\t${Math.trunc(s.mtimeMs)}`;
      if (!done.has(line)) out.push({ path, key, line, size: s.size, mtime: s.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

export async function shipShots(o: ShipOptions): Promise<ShipReport> {
  const todo = await pendingShots(o);
  const report: ShipReport = { shipped: 0, bytes: 0, pending: 0, unreadable: [], refused: null };
  for (const [i, f] of todo.entries()) {
    if (o.dry) {
      report.pending = todo.length;
      break;
    }
    const body = await readFile(f.path).catch(() => null);
    if (!body) {
      report.unreadable.push(f.key);
      continue;
    }
    try {
      await o.store.put(f.key, body, TYPES[extname(f.path)] ?? "application/octet-stream");
    } catch (err) {
      // The store is down or refuses us: every other file would fail the same way.
      report.refused = err instanceof Error ? err.message : String(err);
      report.pending = todo.length - i;
      break;
    }
    await appendFile(o.ledgerFile, `${f.line}\n`);
    report.shipped++;
    report.bytes += f.size;
  }
  return report;
}

export function shipWording(r: ShipReport, bucket: string): string[] {
  const mb = (r.bytes / 1024 / 1024).toFixed(1);
  const lines: string[] = [];
  if (r.shipped) lines.push(`shipped ${r.shipped} files (${mb} MB) to ${bucket}`);
  if (r.refused) lines.push(`${bucket} refused: ${r.refused}; ${r.pending} left, shipped next run`);
  else if (r.pending) lines.push(`${r.pending} files to ship`);
  if (r.unreadable.length) lines.push(`could not read ${r.unreadable.length}: skipped`);
  if (!lines.length) lines.push("nothing new to ship");
  return lines;
}
