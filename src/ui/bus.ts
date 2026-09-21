/**
 * In-process event bus: the UI's live feed. A channel like any other on
 * the way in; on the way out, a bounded ring of recent events for a page
 * that just opened and a subscriber list for SSE. Nothing durable: the
 * registry and each run's status are the truth, the bus is the ticker.
 */
import type { Channel } from "../channels/types.js";
import type { RunEvent } from "../engine/events.js";

export interface EventBus extends Channel {
  /** Newest last; `after` skips events up to and including that seq. */
  recent(after?: number): Array<{ seq: number; event: RunEvent }>;
  subscribe(fn: (seq: number, event: RunEvent) => void): () => void;
}

export function eventBus(capacity = 500): EventBus {
  // A fixed ring: `head` is the oldest slot once full; nothing shifts.
  const ring: Array<{ seq: number; event: RunEvent }> = [];
  let head = 0;
  const subscribers = new Set<(seq: number, event: RunEvent) => void>();
  let seq = 0;
  return {
    name: "ui",
    async deliver(event) {
      const entry = { seq: ++seq, event };
      if (ring.length < capacity) ring.push(entry);
      else {
        ring[head] = entry;
        head = (head + 1) % capacity;
      }
      for (const fn of subscribers) {
        try {
          fn(entry.seq, event);
        } catch {
          // a dead SSE client must not stop the others
        }
      }
    },
    recent(after = 0) {
      // Seqs rise with position from `head`; a page asking for what it missed is bisected to.
      const n = ring.length;
      const at = (i: number) => ring[(head + i) % n] as { seq: number; event: RunEvent };
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (at(mid).seq > after) hi = mid;
        else lo = mid + 1;
      }
      const out: Array<{ seq: number; event: RunEvent }> = [];
      for (let i = lo; i < n; i++) out.push(at(i));
      return out;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
