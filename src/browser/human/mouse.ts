/**
 * How a hand moves a mouse: a curve, not a line; fast in the middle and
 * slow at both ends; longer to far or small targets (Fitts's law); on a
 * long reach it sometimes overshoots and comes back. It lands somewhere
 * inside the control, near the middle, never the same pixel twice.
 *
 * Pure like the typing plan: points in, a path with timings out.
 */
import { chance, clamp, drawLog, drawNormal, type Random } from "./draw.js";

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
  const steps: PathStep[] = [];
  for (let i = 1; i <= n; i++) {
    const t = ease(i / n);
    const u = 1 - t;
    const last = i === n;
    const jitter = last ? 0 : 0.6;
    steps.push({
      x:
        u * u * u * from.x +
        3 * u * u * t * c1.x +
        3 * u * t * t * c2.x +
        t * t * t * to.x +
        drawNormal(jitter, random),
      y:
        u * u * u * from.y +
        3 * u * u * t * c1.y +
        3 * u * t * t * c2.y +
        t * t * t * to.y +
        drawNormal(jitter, random),
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
    return [...curve(from, past, size, s, random), ...curve(past, to, size, s, random)];
  }
  return curve(from, to, size, s, random);
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
