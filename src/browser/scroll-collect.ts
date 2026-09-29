/**
 * Read a feed the way a person does: read what is on screen, scroll most of
 * a screen, read again. Feeds (X, LinkedIn, Instagram) render only the rows
 * near the viewport, so rows are kept by key as they pass. It stops at
 * `max` rows, at a row `stop` says is already known (a cursor: the newest
 * id the caller holds), or when a few scrolls in a row bring nothing new.
 */
import type { FlowPage } from "./flow.js";

export interface ScrollCollect<T> {
  /** The rows on screen now, in page order. */
  read: () => Promise<T[]>;
  key: (row: T) => string;
  max: number;
  /** True for a row the caller already has: collection ends there, the row left out. */
  stop?: (row: T) => boolean;
  /** Rows `stop` is never asked about and that are left out of nothing (a pinned post above the feed). */
  skip?: (row: T) => boolean;
  /** Scrolls in a row with nothing new before the feed counts as ended. */
  idle?: number;
  /** How far one scroll goes, as a share of the window. */
  screens?: number;
  /** ms to let new rows load after a scroll. */
  settleMs?: number;
}

export interface Collected<T> {
  rows: T[];
  /** Why it stopped: enough rows, the cursor was reached, or the feed ran out. */
  ended: "max" | "cursor" | "end";
}

const IDLE = 3;
const SCREENS = 0.85;
const SETTLE_MS = 1_200;
/** No feed read goes on forever, whatever `max` says. */
const MOST_SCROLLS = 200;

export async function scrollCollect<T>(fp: FlowPage, o: ScrollCollect<T>): Promise<Collected<T>> {
  const rows = new Map<string, T>();
  let idle = 0;
  for (let i = 0; i < MOST_SCROLLS; i++) {
    let fresh = 0;
    for (const row of await o.read()) {
      const k = o.key(row);
      if (rows.has(k)) continue;
      const skipped = o.skip?.(row) ?? false;
      if (!skipped && o.stop?.(row)) return { rows: [...rows.values()], ended: "cursor" };
      rows.set(k, row);
      fresh++;
      if (rows.size >= o.max) return { rows: [...rows.values()], ended: "max" };
    }
    idle = fresh ? 0 : idle + 1;
    if (idle >= (o.idle ?? IDLE)) break;
    const height = await fp.page.evaluate<number>("innerHeight").catch(() => 800);
    await fp.scroll(Math.round(height * (o.screens ?? SCREENS)));
    await fp.wait(o.settleMs ?? SETTLE_MS);
  }
  return { rows: [...rows.values()], ended: "end" };
}
