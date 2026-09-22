/**
 * The random draws every human-like motion is made of. Each takes the
 * random source, so a test passes a fixed one and gets the same plan back.
 */
export type Random = () => number;

/** Log-uniform in [lo, hi]: mostly near the low end, now and then slow. Like a person. */
export function drawLog([lo, hi]: readonly [number, number], random: Random): number {
  return Math.exp(Math.log(lo) + random() * (Math.log(hi) - Math.log(lo)));
}

/** The same, whole milliseconds. */
export function drawMs(range: readonly [number, number], random: Random): number {
  return Math.round(drawLog(range, random));
}

/** A whole number in [lo, hi], evenly. */
export function drawInt([lo, hi]: readonly [number, number], random: Random): number {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/** Normal, mean 0, spread `sd` (Box–Muller). */
export function drawNormal(sd: number, random: Random): number {
  const u = Math.max(random(), 1e-9);
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export const chance = (p: number, random: Random): boolean => random() < p;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
