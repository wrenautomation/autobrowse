/**
 * The RL view of a session (autotrack design doc, "Derived offline"): one step per act, joining
 * what the screen showed before (frame, crop, tree, OCR), what the person did (pointer in frame
 * pixels and 0..1, text, key, cursor path), what came of it (settled frame, tree, tree diff,
 * outcome) and what the offline pass knows (signals, intent, episode, goal, capture level).
 *
 * Frames, crops, trees and OCR files are named by number; the step points at them and the trainer
 * reads them from the bucket. Only the trees are read here, to diff the one before the act against
 * the first one after it. The rules are pure, so a rule change reruns over old sessions.
 */
import { looksLikeSecretValue, REDACTED } from "../recorder/redact.js";
import { type Episode, splitEpisodes } from "./episodes.js";
import { type Act, type ActKind, buildActs } from "./join.js";
import { pool } from "./pool.js";
import {
  type ActCapture,
  contextOf,
  levelAt,
  type Quality,
  type QualityContext,
  qualityOf,
} from "./quality.js";
import { signalsFor } from "./signals.js";
import { diffTrees, type TreeDiff, type TreeNode } from "./tree.js";
import type {
  ActSignals,
  Element,
  Event,
  Labels,
  Level,
  Outcome,
  SessionMeta,
  Stats,
} from "./types.js";

/** Frames are capped at this many pixels on the long side (recorder, `capture`). */
export const FRAME_MAX_PX = 1920;
/** The tree "after" an act is the first one within this long, and before the next act. */
export const NEXT_TREE_MS = 5000;
const CHUNK_ACTS = 24;
const CACHE_TREES = 48;
const TREE_READS = 8;

type Display = SessionMeta["displays"][number];

/** Frame pixels per point on a display: its native scale, unless the 1920 px cap shrank the frame. */
export function frameScale(d: Display): number {
  const long = Math.max(d.width, d.height);
  const scale = d.scale > 0 ? d.scale : 1;
  return long > 0 ? Math.min(scale, FRAME_MAX_PX / long) : scale;
}

/** The act's display: the one named, else the one holding the point, else the primary. */
export function displayOf(
  meta: SessionMeta | null,
  id: string | undefined,
  x: number,
  y: number,
): Display | undefined {
  const ds = meta?.displays ?? [];
  const named = id ? ds.find((d) => d.id === id) : undefined;
  return (
    named ??
    ds.find((d) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height) ??
    ds.find((d) => d.primary) ??
    ds[0]
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface FramePoint {
  /** Pixels in the frame. */
  x: number;
  y: number;
  /** 0..1 across the display. */
  nx: number;
  ny: number;
}

/** A global point (logical points, all displays) → its pixel in that display's frame. */
export function toFrame(d: Display, x: number, y: number): FramePoint {
  const s = frameScale(d);
  const lx = clamp(x - d.x, 0, d.width);
  const ly = clamp(y - d.y, 0, d.height);
  return {
    x: Math.round(lx * s),
    y: Math.round(ly * s),
    nx: d.width > 0 ? round4(lx / d.width) : 0,
    ny: d.height > 0 ? round4(ly / d.height) : 0,
  };
}

export interface StepAction extends Partial<FramePoint> {
  type: ActKind;
  button?: string;
  count?: number;
  text?: string;
  key?: string;
  mods?: string[];
  /** Scroll distance. */
  dx?: number;
  dy?: number;
  /** A drag's end; `x, y` is where it began (where the before frame and crop were taken). */
  to?: FramePoint;
  /** The cursor's last second before the act: `[dt ms (negative), x, y]`, x and y in frame pixels. */
  path?: [number, number, number][];
  /** A navigation or tab: where. */
  url?: string;
}

export interface Step {
  episode: string;
  goal?: string;
  /** 0-based within the episode. */
  step: number;
  /** ms since session start. */
  t: number;
  obs: {
    /** `frames/<n>.jpg`, the screen when the act began. */
    frame?: number;
    /** `crops/<n>.jpg`. */
    crop?: number;
    /** `trees/<n>`, the latest before the act. */
    tree?: number;
    /** `ocr/<n>.json.gz` reads the frame above (a `{same: m}` file points at the one with the lines). */
    ocr?: number;
  };
  action: StepAction;
  element?: Element;
  next: {
    /** The settled frame. */
    frame?: number;
    /** The first tree after the act. */
    tree?: number;
  };
  /** ms from the act's end until the screen held still. */
  settle?: number;
  /** True: it held still. False: 3 s ran out. Absent: not measured (lean level, older recorder). */
  settled?: boolean;
  out?: Outcome;
  treeDiff?: TreeDiff;
  signals: ActSignals;
  intent?: string;
  level?: Level;
}

export interface EpisodeQuality extends Quality {
  id: string;
  goal?: string;
  outcome?: string;
  /** ms since session start. */
  start: number;
  end: number;
  /** All the episode's acts, including those that carry no frames. */
  steps: number;
  /** False when `--min-quality` left it out of the steps file. */
  kept: boolean;
}

/** `steps/<device>/<session>.quality.json`. */
export interface QualityReport extends Quality {
  v: 1;
  device: string;
  session: string;
  minQuality: number;
  /** Lines in the steps file. */
  steps: number;
  episodes: EpisodeQuality[];
}

export interface StepsInput {
  device: string;
  session: string;
  events: readonly Event[];
  meta: SessionMeta | null;
  labels: Labels | null;
  stats: readonly Stats[];
  /** Which shipped files exist; a step never points at a file that is not there. */
  has: {
    frame(n: number): boolean;
    crop(n: number): boolean;
    tree(n: number): boolean;
    ocr(n: number): boolean;
  };
  /** The named nodes of tree `n`; undefined when it cannot be read. */
  tree(n: number): Promise<TreeNode[] | undefined>;
  /** Leave out episodes scoring below this (0..1). Default 0: keep all. */
  minQuality?: number;
}

type OsEvent = Extract<Event, { kind: "click" | "drag" | "scroll" | "text" | "key" }>;
const CLIPBOARD = new Set(["copy", "cut", "paste", "select"]);
const OS_KINDS = new Set(["click", "drag", "scroll", "text", "key"]);
const osEvent = (a: Act): OsEvent | undefined =>
  OS_KINDS.has(a.event.kind) ? (a.event as OsEvent) : undefined;

interface Planned {
  step: Step;
  /** The trees to diff, when both exist. */
  trees?: [number, number];
  capture: ActCapture;
  act: Act;
}

function actionOf(act: Act, ev: OsEvent | undefined, meta: SessionMeta | null): StepAction {
  const a: StepAction = { type: act.kind };
  const startsAt =
    ev?.kind === "drag"
      ? { x: ev.x0, y: ev.y0 }
      : act.x !== undefined && act.y !== undefined
        ? { x: act.x, y: act.y }
        : undefined;
  const d = startsAt ? displayOf(meta, act.event.display, startsAt.x, startsAt.y) : undefined;
  if (startsAt && d) Object.assign(a, toFrame(d, startsAt.x, startsAt.y));
  if (ev?.kind === "drag" && d) a.to = toFrame(d, ev.x, ev.y);
  if (ev?.kind === "click" || ev?.kind === "drag") a.button = ev.button;
  else if (act.web?.button) a.button = act.web.button;
  if (act.kind === "click") a.count = act.count;
  if (ev?.kind === "scroll") {
    a.dx = ev.dx;
    a.dy = ev.dy;
  }
  const clip = act.web && CLIPBOARD.has(act.web.act) ? act.web.text : undefined;
  const raw = act.kind === "text" ? act.text : act.kind === "search" ? act.web?.query : clip;
  if (raw || (act.kind === "text" && act.redacted))
    a.text = act.redacted || looksLikeSecretValue(raw ?? "") ? REDACTED : (raw as string);
  if (ev?.kind === "key") {
    a.key = ev.key;
    a.mods = [...ev.mods];
  }
  if (ev && "path" in ev && ev.path?.length) {
    // The path is global points like the click; it shares the click's display.
    const first = ev.path[0] as [number, number, number];
    const pd = d ?? displayOf(meta, act.event.display, first[1], first[2]);
    a.path = ev.path.map(([dt, px, py]) => {
      if (!pd) return [dt, px, py];
      const f = toFrame(pd, px, py);
      return [dt, f.x, f.y];
    });
  }
  if ((act.kind === "nav" || act.kind === "tab") && act.url) a.url = act.url;
  return a;
}

/** Index of the last item with `ts <= at` in a time-sorted list; -1 when none. */
function lastAtOrBefore(list: readonly { ts: number }[], at: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as { ts: number }).ts <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** One planned step per act, in act order. Pure: no files read. */
function plan(
  i: StepsInput,
  acts: readonly Act[],
  episodes: readonly Episode[],
  ctx: QualityContext,
): { byEpisode: Planned[][] } {
  const { has, meta } = i;
  const signals = signalsFor(acts, i.events);
  const intents = new Map<number, string>();
  for (const a of i.labels?.acts ?? []) if (a.intent) intents.set(a.t, a.intent);
  const labelOf = new Map((i.labels?.episodes ?? []).map((e) => [e.id, e]));

  // Every tree the recorder wrote, in time order: `tree` events and a page snapshot's `treeFile`.
  const trees = i.events
    .flatMap((e) => {
      const n = e.kind === "tree" ? e.tree : e.kind === "web" ? e.treeFile : undefined;
      return n !== undefined && has.tree(n) ? [{ ts: e.ts, n }] : [];
    })
    .sort((a, b) => a.ts - b.ts);

  const byEpisode: Planned[][] = [];
  for (const ep of episodes) {
    const label = labelOf.get(ep.id);
    const goal = label?.goal?.trim() || ep.goal;
    const list: Planned[] = [];
    for (let k = ep.from; k < ep.to; k++) {
      const act = acts[k] as Act;
      const ev = osEvent(act);
      const beforeN = ev?.before !== undefined && has.frame(ev.before) ? ev.before : undefined;
      const afterN = ev?.after !== undefined && has.frame(ev.after) ? ev.after : undefined;
      const cropN =
        ev && "crop" in ev && ev.crop !== undefined && has.crop(ev.crop) ? ev.crop : undefined;
      const treeBefore =
        ev?.tree !== undefined && has.tree(ev.tree)
          ? ev.tree
          : trees[lastAtOrBefore(trees, act.ts)]?.n;
      const limit = Math.min(acts[k + 1]?.ts ?? Number.POSITIVE_INFINITY, act.end + NEXT_TREE_MS);
      const after = trees[lastAtOrBefore(trees, act.ts) + 1];
      const treeAfter = after && after.ts <= limit ? after.n : undefined;
      const settled = ev?.settled ?? (ev?.settle !== undefined ? true : undefined);
      const intent = intents.get(act.t);
      const level = levelAt(ctx.levels, act.ts);
      const step: Step = {
        episode: ep.id,
        ...(goal ? { goal } : {}),
        step: k - ep.from,
        t: act.t,
        obs: {
          ...(beforeN !== undefined ? { frame: beforeN } : {}),
          ...(cropN !== undefined ? { crop: cropN } : {}),
          ...(treeBefore !== undefined ? { tree: treeBefore } : {}),
          ...(beforeN !== undefined && has.ocr(beforeN) ? { ocr: beforeN } : {}),
        },
        action: actionOf(act, ev, meta),
        ...(act.element ? { element: act.element } : {}),
        next: {
          ...(afterN !== undefined ? { frame: afterN } : {}),
          ...(treeAfter !== undefined ? { tree: treeAfter } : {}),
        },
        ...(ev?.settle !== undefined ? { settle: ev.settle } : {}),
        ...(settled !== undefined ? { settled } : {}),
        ...(ev?.out ? { out: ev.out } : {}),
        signals: signals[k] as ActSignals,
        ...(intent ? { intent } : {}),
        ...(level ? { level } : {}),
      };
      const p: Planned = {
        step,
        act,
        capture: {
          os: ev !== undefined,
          pointer: ev?.kind === "click" || ev?.kind === "drag" || ev?.kind === "scroll",
          frames: beforeN !== undefined && afterN !== undefined && settled === true,
          element: act.element !== undefined,
          tree: treeBefore !== undefined,
          crop: cropN !== undefined,
        },
        ...(treeBefore !== undefined && treeAfter !== undefined && treeBefore !== treeAfter
          ? { trees: [treeBefore, treeAfter] as [number, number] }
          : {}),
      };
      list.push(p);
    }
    byEpisode.push(list);
  }
  return { byEpisode };
}

/** The steps of a session (episodes under `minQuality` left out) and its quality report. */
export async function buildSteps(i: StepsInput): Promise<{ steps: Step[]; report: QualityReport }> {
  const acts = buildActs(i.events);
  const episodes = splitEpisodes(acts, i.events);
  const ctx = contextOf(i.events, i.stats);
  const { byEpisode } = plan(i, acts, episodes, ctx);
  const minQuality = i.minQuality ?? 0;
  const labelOf = new Map((i.labels?.episodes ?? []).map((e) => [e.id, e]));

  const tss = i.events.map((e) => e.ts);
  const span = tss.length
    ? { from: tss.reduce((a, b) => Math.min(a, b)), to: tss.reduce((a, b) => Math.max(a, b)) }
    : { from: 0, to: 0 };
  const episodeReports: EpisodeQuality[] = episodes.map((ep, k) => {
    const list = byEpisode[k] as Planned[];
    const q = qualityOf(
      list.map((p) => p.capture),
      { from: (acts[ep.from] as Act).ts, to: (acts[ep.to - 1] as Act).end },
      ctx,
    );
    const label = labelOf.get(ep.id);
    const goal = label?.goal?.trim() || ep.goal;
    return {
      id: ep.id,
      ...(goal ? { goal } : {}),
      ...(label?.outcome ? { outcome: label.outcome } : {}),
      start: ep.start,
      end: ep.end,
      steps: list.length,
      kept: q.score >= minQuality,
      ...q,
    };
  });

  const kept = byEpisode.filter((_, k) => (episodeReports[k] as EpisodeQuality).kept).flat();
  await diffAll(i, kept);
  const steps = kept.map((p) => p.step);
  const session = qualityOf(
    byEpisode.flat().map((p) => p.capture),
    span,
    ctx,
    { withRestarts: true },
  );
  return {
    steps,
    report: {
      v: 1,
      device: i.device,
      session: i.session,
      minQuality,
      steps: steps.length,
      episodes: episodeReports,
      ...session,
    },
  };
}

/** Fill `treeDiff` where an act has a tree before and one after. Trees load a chunk at a time. */
async function diffAll(i: StepsInput, planned: readonly Planned[]): Promise<void> {
  const cache = new Map<number, TreeNode[] | null>();
  const load = async (n: number) => {
    cache.set(n, (await i.tree(n)) ?? null);
  };
  for (let at = 0; at < planned.length; at += CHUNK_ACTS) {
    const chunk = planned.slice(at, at + CHUNK_ACTS);
    const need = [...new Set(chunk.flatMap((p) => p.trees ?? []))].filter((n) => !cache.has(n));
    await pool(need, TREE_READS, load);
    for (const p of chunk) {
      if (!p.trees) continue;
      const before = cache.get(p.trees[0]);
      const after = cache.get(p.trees[1]);
      if (before && after) p.step.treeDiff = diffTrees(before, after);
    }
    for (const n of cache.keys()) {
      if (cache.size <= CACHE_TREES) break;
      cache.delete(n);
    }
  }
}

/** One JSON object per line. */
export const stepsJsonl = (steps: readonly Step[]): string =>
  steps.map((s) => `${JSON.stringify(s)}\n`).join("");
