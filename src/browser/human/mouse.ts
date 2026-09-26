/**
 * How a hand moves a mouse: a curve, not a line; fast in the middle and
 * slow at both ends; longer to far or small targets (Fitts's law); on a
 * long reach it sometimes overshoots and comes back, or stops part way
 * and goes on. It lands somewhere inside the control, near the middle,
 * never the same pixel twice. A hand resting on the mouse is not frozen:
 * every pause drifts a pixel or so and comes back.
 *
 * Pure like the typing plan: points in, a path with timings out.
 */
import { chance, clamp, drawInt, drawLog, drawMs, drawNormal, type Random } from "./draw.js";

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

export interface MouseStyle {
  /** Fitts: ms before distance counts, and ms per bit of difficulty. */
  reach: [number, number];
  perBit: [number, number];
  /** Chance a long reach (over 250px) overshoots, and by how much of the distance. */
  overshoot: number;
  overshootBy: [number, number];
  /** Resting on the control before pressing, ms. */
  hover: [number, number];
  /** Button held down, ms. */
  hold: [number, number];
  /** Hand tremor, px: the pointer is never still or straight between frames. */
  tremor: number;
  /** An idle wander: how many stops, and how long the hand rests at each, ms. */
  wanderStops: [number, number];
  wanderRest: [number, number];
  /** Chance a reach stops part way, and for how long, ms. */
  hesitate: number;
  hesitateMs: [number, number];
  /** A resting hand's drift, px, and how far apart its small moves come, ms. */
  jitter: number;
  jitterGap: [number, number];
}

export interface PathStep extends Point {
  /** Wait this long after moving here. */
  after: number;
}

/** One mouse event per ~frame, like a real pointer. */
const FRAME_MS = 14;

/** Where in the box to press: around the middle, inside its inner 70%. */
export function aimPoint(box: Box, random: Random): Point {
  return {
    x: clamp(
      box.x + box.width / 2 + drawNormal(box.width / 7, random),
      box.x + box.width * 0.15,
      box.x + box.width * 0.85,
    ),
    y: clamp(
      box.y + box.height / 2 + drawNormal(box.height / 7, random),
      box.y + box.height * 0.15,
      box.y + box.height * 0.85,
    ),
  };
}

/**
 * Tremor: a smooth wobble, not white noise. A fast shake (8–12 Hz, as a
 * hand's is) over a slow sway (1–2 Hz), each with its own phase, so two
 * paths never wobble alike and neighbouring frames move together.
 */
export function tremor(px: number, random: Random): (ms: number) => Point {
  const wave = (hz: number, amp: number) => {
    const phase = random() * 2 * Math.PI;
    const w = (2 * Math.PI * hz) / 1000;
    return (ms: number) => amp * Math.sin(w * ms + phase);
  };
  const fx = [wave(8 + random() * 4, px * 0.5), wave(1 + random(), px)];
  const fy = [wave(8 + random() * 4, px * 0.5), wave(1 + random(), px)];
  return (ms) => ({
    x: fx.reduce((n, f) => n + f(ms), 0),
    y: fy.reduce((n, f) => n + f(ms), 0),
  });
}

/** Minimum-jerk easing: the speed profile of a real reach. */
const ease = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

function curve(from: Point, to: Point, size: number, s: MouseStyle, random: Random): PathStep[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [];
  // Perpendicular unit: the curve bows to one side, as a wrist does.
  const px = -dy / dist;
  const py = dx / dist;
  const bow = drawNormal(dist * 0.12, random);
  const c1 = {
    x: from.x + dx * 0.3 + px * bow,
    y: from.y + dy * 0.3 + py * bow,
  };
  const c2 = {
    x: from.x + dx * 0.7 + px * bow * 0.6,
    y: from.y + dy * 0.7 + py * bow * 0.6,
  };
  const ms =
    drawLog(s.reach, random) + drawLog(s.perBit, random) * Math.log2(1 + dist / Math.max(size, 8));
  const n = Math.max(6, Math.round(ms / FRAME_MS));
  const shake = tremor(s.tremor, random);
  const steps: PathStep[] = [];
  for (let i = 1; i <= n; i++) {
    const t = ease(i / n);
    const u = 1 - t;
    // The wobble fades as the hand settles, and is gone on the last frame.
    const w = i === n ? { x: 0, y: 0 } : shake((i * ms) / n);
    const fade = 1 - t * t;
    steps.push({
      x:
        u * u * u * from.x +
        3 * u * u * t * c1.x +
        3 * u * t * t * c2.x +
        t * t * t * to.x +
        w.x * fade,
      y:
        u * u * u * from.y +
        3 * u * u * t * c1.y +
        3 * u * t * t * c2.y +
        t * t * t * to.y +
        w.y * fade,
      after: Math.round(ms / n),
    });
  }
  return steps;
}

/** From where the pointer is to a point in a target `size` px across. */
export function mousePath(
  from: Point,
  to: Point,
  size: number,
  s: MouseStyle,
  random: Random,
): PathStep[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist > 250 && chance(s.overshoot, random)) {
    const by = drawLog(s.overshootBy, random);
    const past = {
      x: to.x + ((to.x - from.x) / dist) * dist * by + drawNormal(4, random),
      y: to.y + ((to.y - from.y) / dist) * dist * by + drawNormal(4, random),
    };
    return [...reach(from, past, size, s, random), ...curve(past, to, size, s, random)];
  }
  return reach(from, to, size, s, random);
}

/** A reach that sometimes stops part way, a little off the line, rests, and goes on. */
function reach(from: Point, to: Point, size: number, s: MouseStyle, random: Random): PathStep[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 60 || !chance(s.hesitate, random)) return curve(from, to, size, s, random);
  const t = 0.35 + random() * 0.4;
  const mid = {
    x: from.x + (to.x - from.x) * t + drawNormal(dist * 0.04, random),
    y: from.y + (to.y - from.y) * t + drawNormal(dist * 0.04, random),
  };
  return [
    // Nowhere in particular to land part way: a wide target.
    ...curve(from, mid, 80, s, random),
    ...restAt(mid, drawMs(s.hesitateMs, random), s, random),
    ...curve(mid, to, size, s, random),
  ];
}

/**
 * A hand resting on the mouse for `ms`: a small move now and then, a pixel
 * or so off, then back on `at`. The waits add up to `ms`.
 */
export function restAt(at: Point, ms: number, s: MouseStyle, random: Random): PathStep[] {
  const shake = tremor(s.jitter, random);
  const steps: PathStep[] = [];
  for (let spent = 0; spent < ms; ) {
    const gap = Math.min(drawMs(s.jitterGap, random), ms - spent);
    const w = shake(spent);
    steps.push({ x: at.x + w.x, y: at.y + w.y, after: gap });
    spent += gap;
  }
  if (steps.length) steps.push({ ...at, after: 0 });
  return steps;
}

/**
 * An idle hand: a few stops across the page, some near, some a long way,
 * each reach its own speed, a rest at each. What a person's pointer does
 * while they read.
 */
export function wanderPath(
  from: Point,
  view: { width: number; height: number },
  s: MouseStyle,
  random: Random,
): PathStep[] {
  const steps: PathStep[] = [];
  let at = from;
  const stops = drawInt(s.wanderStops, random);
  for (let i = 0; i < stops; i++) {
    const far = chance(0.3, random);
    const to = far
      ? { x: 5 + random() * (view.width - 10), y: 5 + random() * (view.height - 10) }
      : driftPoint(at, view, random);
    steps.push(
      ...mousePath(at, to, 40, s, random),
      ...restAt(to, drawMs(s.wanderRest, random), s, random),
    );
    at = to;
  }
  return steps;
}

/** Somewhere a resting hand drifts to while reading: near, inside the page. */
export function driftPoint(
  from: Point,
  view: { width: number; height: number },
  random: Random,
): Point {
  return {
    x: clamp(from.x + drawNormal(90, random), 5, view.width - 5),
    y: clamp(from.y + drawNormal(60, random), 5, view.height - 5),
  };
}
