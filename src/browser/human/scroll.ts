/**
 * How a hand scrolls: wheel notches, not a jump. Each notch moves about
 * the same distance, a flick is a few quick notches, then a pause to look
 * before the next flick. Landing short or a little past is fine; the
 * caller finishes with the exact scroll.
 *
 * Pure like the other plans: a distance in, notches with timings out.
 */
import { chance, drawInt, drawLog, drawMs, type Random } from "./draw.js";

export interface ScrollStyle {
  /** Pixels one wheel notch moves. */
  notch: [number, number];
  /** Notches in one flick, and ms between them. */
  flick: [number, number];
  gap: [number, number];
  /** A look between flicks, ms. */
  look: [number, number];
  /** Past this many px, the page jumps instead (nobody wheels a mile). */
  most: number;
}

export interface WheelStep {
  dy: number;
  after: number;
}

export function wheelPlan(dy: number, s: ScrollStyle, random: Random): WheelStep[] {
  const sign = Math.sign(dy);
  let left = Math.abs(dy);
  const steps: WheelStep[] = [];
  while (left > 0) {
    const n = drawInt(s.flick, random);
    for (let i = 0; i < n && left > 0; i++) {
      const move = Math.min(left, Math.round(drawLog(s.notch, random)));
      left -= move;
      steps.push({ dy: sign * move, after: drawMs(s.gap, random) });
    }
    const last = steps.at(-1);
    if (last && left > 0) last.after += drawMs(s.look, random);
  }
  // Now and then the last flick carries one notch past.
  if (steps.length && chance(0.25, random))
    steps.push({
      dy: sign * Math.round(drawLog(s.notch, random) * 0.5),
      after: drawMs(s.gap, random),
    });
  return steps;
}
