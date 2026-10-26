/**
 * What a run's model saw, for training (designs/2026-10-26-run-observations.md): each answer
 * and page tree, masked, once per hash in `<site>/<run>.obs.jsonl`, zstd at the run's end;
 * pictures as `blobs/<hash>.jpg`. Rows name them by hash. Both ship to the bucket and then
 * leave this disk (`clearShipped`); the run file stays.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { redactAria, redactText } from "../recorder/redact.js";
import { baseSite } from "./log.js";

export const BLOBS = "blobs";
/** Sixteen hex: unique enough within a machine's runs, short in every row. */
const hashOf = (b: string | Uint8Array): string =>
  createHash("sha256").update(b).digest("hex").slice(0, 16);

export const obsFile = (dir: string, site: string, run: string): string =>
  join(dir, baseSite(site), `${run}.obs.jsonl`);

/** Masked as a transcript is: secret-shaped values, then filled secret fields. */
export const maskObs = (text: string): string => redactAria(redactText(text));

export interface Capture {
  /** Stores the masked text once; its hash. */
  text(text: string): string;
  /** Stores a picture once; its hash. */
  picture(jpeg: Uint8Array): string;
  /** zstd the text file, so it ships; a later life of the run starts a new one beside it. */
  close(): void;
}

export function captureFor(dir: string, site: string, run: string): Capture {
  const file = obsFile(dir, site, run);
  const blobs = join(dir, BLOBS);
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const seen = new Set<string>();
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n"))
      if (line.startsWith('{"h":"')) seen.add(line.slice(6, 22));
  return {
    text(raw) {
      const text = maskObs(raw);
      const h = hashOf(text);
      if (!seen.has(h)) {
        seen.add(h);
        appendFileSync(file, `${JSON.stringify({ h, text })}\n`, { mode: 0o600 });
      }
      return h;
    },
    picture(jpeg) {
      const h = hashOf(jpeg);
      const to = join(blobs, `${h}.jpg`);
      if (!existsSync(to)) writeFileSync(to, jpeg, { mode: 0o600 });
      return h;
    },
    close() {
      if (!existsSync(file)) return;
      packObs(file);
    },
  };
}

/** `<run>.obs.jsonl` → `<run>.obs.<mtime>.jsonl.zst`: each life's file ships under its own key. */
export function packObs(file: string): string {
  const stamp = Math.trunc(statSync(file).mtimeMs);
  const to = file.replace(/\.jsonl$/, `.${stamp}.jsonl.zst`);
  writeFileSync(
    to,
    zstdCompressSync(readFileSync(file), {
      params: {
        [constants.ZSTD_c_compressionLevel]: 19,
        [constants.ZSTD_c_enableLongDistanceMatching]: 1,
      },
    }),
    { mode: 0o600 },
  );
  rmSync(file);
  return to;
}

/** A life that died before its end (a crash) leaves its text file: packed once a day has passed. */
export function packStale(dir: string, now = Date.now()): number {
  let n = 0;
  if (!existsSync(dir)) return n;
  for (const site of readdirSync(dir, { withFileTypes: true })) {
    if (!site.isDirectory() || site.name === BLOBS) continue;
    for (const f of readdirSync(join(dir, site.name))) {
      const p = join(dir, site.name, f);
      if (f.endsWith(".obs.jsonl") && now - statSync(p).mtimeMs > 86_400_000) {
        packObs(p);
        n++;
      }
    }
  }
  return n;
}

/** What ships from the runs folder: run files, packed texts, pictures. */
export const keepRun = (rel: string): boolean =>
  /\.obs\.\d+\.jsonl\.zst$/.test(rel) ||
  rel.startsWith(`${BLOBS}/`) ||
  /\/\d{8}-\d{6}-[0-9a-f]{4}\.jsonl$/.test(rel) ||
  rel === "index.jsonl";

/** What leaves this disk once the bucket has it: texts and pictures; run files stay. */
export const clearRun = (rel: string): boolean =>
  /\.obs\.\d+\.jsonl\.zst$/.test(rel) || rel.startsWith(`${BLOBS}/`);
