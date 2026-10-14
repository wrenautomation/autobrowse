/**
 * How complete a session's data is for training (autotrack design doc, "Derived offline"): the
 * share of acts with a before frame and a settled after frame, an element, a tree and a crop; the
 * time spent at each capture level; and the gaps (pauses, helper restarts). One `score` (0..1) per
 * episode and per session, the mean of the shares that could apply, is what `steps --min-quality`
 * filters on. Pure: events and per-act booleans in, numbers out.
 */
import { pausedSpans } from "./label.js";
import type { Event, Level, Stats } from "./types.js";

/** What one act has of what a training step wants. */
export interface ActCapture {
  /** An OS act (click, drag, scroll, text, key): the only kind that carries frames. */
  os: boolean;
  /** click, drag, scroll: the kinds that take a crop. */
  pointer: boolean;
  /** A before frame and a settled after frame, both shipped. */
  frames: boolean;
  element: boolean;
  tree: boolean;
  crop: boolean;
}

export interface Quality {
  /** Acts the shares count: the OS acts. A browser-only act (a typed URL) has no frames to miss. */
  acts: number;
  /** Shares in 0..1; null when no act could have had it. */
  frames: number | null;
  element: number | null;
  tree: number | null;
  /** Over the pointer acts. */
  crop: number | null;
  /** The mean of the shares that are not null; 0 when there are none. */
  score: number;
  /** ms spent at each level; time before the first `level` event is unknown, not counted. */
  levelMs: Partial<Record<Level, number>>;
  gaps: { pauses: number; pausedMs: number; helperRestarts?: number };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function share(
  rows: readonly ActCapture[],
  applies: (r: ActCapture) => boolean,
  has: keyof ActCapture,
) {
  const over = rows.filter(applies);
  return over.length ? round3(over.filter((r) => r[has]).length / over.length) : null;
}

export interface LevelPoint {
  ts: number;
  level: Level;
}

/** The `level` events, in time order. */
export function levelPoints(events: readonly Event[]): LevelPoint[] {
  return events
    .flatMap((e) => (e.kind === "level" ? [{ ts: e.ts, level: e.level }] : []))
    .sort((a, b) => a.ts - b.ts);
}

/** The level in force at `ts`; undefined before the first event (and for old sessions, always). */
export function levelAt(levels: readonly LevelPoint[], ts: number): Level | undefined {
  let found: Level | undefined;
  for (const p of levels) {
    if (p.ts > ts) break;
    found = p.level;
  }
  return found;
}

/** ms at each level inside [from, to]. */
export function levelTime(
  levels: readonly LevelPoint[],
  from: number,
  to: number,
): Partial<Record<Level, number>> {
  const out: Partial<Record<Level, number>> = {};
  levels.forEach((p, i) => {
    const lo = Math.max(p.ts, from);
    const hi = Math.min(levels[i + 1]?.ts ?? to, to);
    if (hi > lo) out[p.level] = (out[p.level] ?? 0) + (hi - lo);
  });
  return out;
}

export interface QualityContext {
  levels: readonly LevelPoint[];
  pauses: readonly { from: number; to: number }[];
  helperRestarts?: number;
}

/** Helper restarts in one segment's stats: the sum over helpers, numbers only. */
function restartsOf(s: Partial<Stats>): number {
  const r = s.restarts;
  if (!r || typeof r !== "object") return 0;
  return Object.values(r).reduce((n, v) => n + (typeof v === "number" && v > 0 ? v : 0), 0);
}

export function contextOf(events: readonly Event[], stats: readonly Stats[]): QualityContext {
  const restarts = stats.reduce((n, s) => n + restartsOf(s), 0);
  return {
    levels: levelPoints(events),
    pauses: pausedSpans(events),
    ...(stats.length ? { helperRestarts: restarts } : {}),
  };
}

/** Quality of `rows` over the epoch-ms span [from, to]. */
export function qualityOf(
  rows: readonly ActCapture[],
  span: { from: number; to: number },
  ctx: QualityContext,
  o: { withRestarts?: boolean } = {},
): Quality {
  const os = rows.filter((r) => r.os);
  const frames = share(os, () => true, "frames");
  const element = share(os, () => true, "element");
  const tree = share(os, () => true, "tree");
  const crop = share(os, (r) => r.pointer, "crop");
  const present = [frames, element, tree, crop].filter((s): s is number => s !== null);
  const overlaps = ctx.pauses
    .map((p) => ({ from: Math.max(p.from, span.from), to: Math.min(p.to, span.to) }))
    .filter((p) => p.to > p.from);
  return {
    acts: os.length,
    frames,
    element,
    tree,
    crop,
    score: present.length ? round3(present.reduce((a, b) => a + b, 0) / present.length) : 0,
    levelMs: levelTime(ctx.levels, span.from, span.to),
    gaps: {
      pauses: overlaps.length,
      pausedMs: overlaps.reduce((n, p) => n + (p.to - p.from), 0),
      ...(o.withRestarts && ctx.helperRestarts !== undefined
        ? { helperRestarts: ctx.helperRestarts }
        : {}),
    },
  };
}
