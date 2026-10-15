/**
 * How long to wait before each status read of a job a platform runs in the background (a video
 * LinkedIn processes, a post TikTok publishes): 5 s, 10 s, 15 s, then 20 s, trimmed so they add
 * up to `totalMs`. Most jobs finish in under a minute, so the early reads catch them; a stuck one
 * costs about a third of the reads a flat 5 s would. One read goes first, one after each wait.
 */
export function pollWaits(totalMs: number): number[] {
  const waits: number[] = [];
  let spent = 0;
  while (spent < totalMs) {
    const wait = Math.min(Math.min(5_000 * (waits.length + 1), 20_000), totalMs - spent);
    waits.push(wait);
    spent += wait;
  }
  return waits;
}
