/**
 * Running the steps pass over a session in the bucket: read the events, trees and labels, build
 * the RL view, write `steps/<device>/<session>.jsonl.gz` and `….quality.json` to the bucket and a
 * copy beside the import cache (`<recordings>/<device>-<session>/track/steps.jsonl.gz`,
 * `quality.json`). The quality file goes last, so one in the bucket means the steps are there.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { readLabels, readSession, readStats } from "./import.js";
import { pool } from "./pool.js";
import { buildSteps, type QualityReport, stepsJsonl } from "./steps.js";
import type { SessionRow, TrackStore, TrackWriter } from "./store.js";
import { parseTree } from "./tree.js";

export const stepsKey = (device: string, session: string) => `steps/${device}/${session}.jsonl.gz`;
export const qualityKey = (device: string, session: string) =>
  `steps/${device}/${session}.quality.json`;

export interface StepsRunOptions {
  /** The recordings root (settings.recordingsDir, expanded). */
  root: string;
  /** Leave out episodes scoring below this (0..1). */
  minQuality?: number;
}

export interface StepsRunResult {
  ref: string;
  report: QualityReport;
  /** Lines written to the steps file. */
  steps: number;
  dir: string;
}

const nameOf = (device: string, session: string) => `${device}-${session.toLowerCase()}`;

export async function stepsOne(
  store: TrackWriter,
  ref: { device: string; session: string },
  o: StepsRunOptions,
): Promise<StepsRunResult> {
  const data = await readSession(store, ref);
  const trackDir = join(o.root, nameOf(ref.device, ref.session), "track");
  const stats = (await readStats(store, data)).map((s) => s.stats);
  const labels = await readLabels(store, ref, join(trackDir, "labels.json"));
  const { steps, report } = await buildSteps({
    device: ref.device,
    session: ref.session,
    events: data.events,
    meta: data.meta,
    labels,
    stats,
    has: {
      frame: (n) => data.frameKeys.has(n),
      crop: (n) => data.cropKeys.has(n),
      tree: (n) => data.treeKeys.has(n),
      ocr: (n) => data.ocrKeys.has(n),
    },
    tree: async (n) => {
      const t = data.treeKeys.get(n);
      if (!t) return undefined;
      try {
        return parseTree(gunzipSync(await store.get(t.key)).toString("utf8"), t.ext);
      } catch {
        return undefined;
      }
    },
    ...(o.minQuality !== undefined ? { minQuality: o.minQuality } : {}),
  });
  const body = gzipSync(Buffer.from(stepsJsonl(steps)));
  const quality = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await store.put(stepsKey(ref.device, ref.session), body, "application/gzip");
  await store.put(qualityKey(ref.device, ref.session), quality);
  await mkdir(trackDir, { recursive: true });
  await writeFile(join(trackDir, "steps.jsonl.gz"), body);
  await writeFile(join(trackDir, "quality.json"), quality);
  return { ref: `${ref.device}/${ref.session}`, report, steps: steps.length, dir: trackDir };
}

/** The quality reports in the bucket for `rows`, by `device/session`. A bad file is skipped. */
export async function readQualities(
  store: TrackStore,
  rows: readonly Pick<SessionRow, "device" | "session">[],
): Promise<Map<string, QualityReport>> {
  const have = new Set((await store.list("steps/")).map((x) => x.key));
  const want = rows.filter((r) => have.has(qualityKey(r.device, r.session)));
  const got = await pool(want, 8, async (r) => {
    try {
      const q = JSON.parse(
        (await store.get(qualityKey(r.device, r.session))).toString("utf8"),
      ) as QualityReport;
      return typeof q.score === "number"
        ? ([`${r.device}/${r.session}`, q] as [string, QualityReport])
        : undefined;
    } catch {
      return undefined;
    }
  });
  return new Map(got.filter((g): g is [string, QualityReport] => g !== undefined));
}

/** `quality 0.82  full 62% normal 38%  paused 2m` for `autotrack list`. */
export function qualityLine(q: QualityReport): string {
  const total = Object.values(q.levelMs).reduce((a, b) => a + b, 0);
  const mix = (["full", "normal", "lean"] as const)
    .filter((l) => (q.levelMs[l] ?? 0) > 0)
    .map((l) => `${l} ${Math.round(((q.levelMs[l] ?? 0) / total) * 100)}%`)
    .join(" ");
  const paused = q.gaps.pausedMs >= 60_000 ? `paused ${Math.round(q.gaps.pausedMs / 60_000)}m` : "";
  const restarts = q.gaps.helperRestarts ? `restarts ${q.gaps.helperRestarts}` : "";
  return [`quality ${q.score.toFixed(2)}`, mix, paused, restarts].filter(Boolean).join("  ");
}
