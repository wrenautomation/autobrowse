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
  const ring: Array<{ seq: number; event: RunEvent }> = [];
  const subscribers = new Set<(seq: number, event: RunEvent) => void>();
  let seq = 0;
  return {
    name: "ui",
    async deliver(event) {
      const entry = { seq: ++seq, event };
      ring.push(entry);
      if (ring.length > capacity) ring.shift();
      for (const fn of subscribers) {
        try {
          fn(entry.seq, event);
        } catch {
          // a dead SSE client must not stop the others
        }
      }
    },
    recent(after = 0) {
      return ring.filter((e) => e.seq > after);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
