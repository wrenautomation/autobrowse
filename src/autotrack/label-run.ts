/**
 * Running the labelling pass over sessions in the bucket: read the events, label, write
 * `labels/<device>/<session>.json` to the bucket and a copy beside the import cache
 * (`<recordings>/<device>-<session>/track/labels.json`). A session whose model failed is not
 * written, so the next run (`--all`) tries it again; calls that did succeed are in the cache.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Llm } from "../llm/index.js";
import { readSession } from "./import.js";
import { fileCache, type LabelStats, labelKey, labelSession, sipsShrink } from "./label.js";
import { listSessions, type TrackWriter } from "./store.js";
import type { Labels } from "./types.js";

export interface LabelRunOptions {
  /** The recordings root (settings.recordingsDir, expanded). */
  root: string;
  /** Null: rules only. */
  llm: Llm | null;
  shrink?: (jpg: Buffer) => Promise<Buffer>;
  log?: (line: string) => void;
}

export interface LabelRunResult {
  ref: string;
  labels: Labels;
  stats: LabelStats;
  /** False when the model failed on an episode: nothing was written. */
  written: boolean;
  dir: string;
}

const nameOf = (device: string, session: string) => `${device}-${session.toLowerCase()}`;

export async function labelOne(
  store: TrackWriter,
  ref: { device: string; session: string },
  o: LabelRunOptions,
): Promise<LabelRunResult> {
  const data = await readSession(store, ref);
  const trackDir = join(o.root, nameOf(ref.device, ref.session), "track");
  const { labels, stats } = await labelSession({
    device: ref.device,
    session: ref.session,
    ...(data.meta?.os ? { os: data.meta.os } : {}),
    events: data.events,
    frame: async (n) => {
      const key = data.frameKeys.get(n);
      return key ? store.get(key) : undefined;
    },
    has: (n) => data.frameKeys.has(n),
    shrink: o.shrink ?? sipsShrink,
    llm: o.llm,
    cache: fileCache(join(trackDir, "label-cache")),
    ...(o.log ? { log: o.log } : {}),
  });
  const written = stats.failed.length === 0;
  if (written) {
    const body = Buffer.from(`${JSON.stringify(labels, null, 2)}\n`);
    await store.put(labelKey(ref.device, ref.session), body);
    await mkdir(trackDir, { recursive: true });
    await writeFile(join(trackDir, "labels.json"), body);
  }
  return { ref: `${ref.device}/${ref.session}`, labels, stats, written, dir: trackDir };
}

/** Sessions with no labels object yet. */
export async function unlabelled(store: TrackWriter, device?: string) {
  const sessions = await listSessions(store, device);
  const have = new Set((await store.list("labels/")).map((x) => x.key));
  return sessions.filter((s) => !have.has(labelKey(s.device, s.session)));
}
