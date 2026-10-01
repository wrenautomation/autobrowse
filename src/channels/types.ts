/**
 * A channel delivers run events to people and systems, and turns what
 * they say back into commands. Email, a webhook, iMessage: same shape.
 */
import type { RunEvent } from "../engine/events.js";
import type { FeedPoint } from "../engine/feed.js";

export interface Channel {
  name: string;
  /** `feed`: the caller's hook for this run, when it asked for one (`forwardChannel` reads it). */
  deliver(event: RunEvent, feed?: FeedPoint): Promise<void>;
  /**
   * A bare line to the person, outside any run: "tap Yes on your phone".
   * Channels that reach a person carry it; a webhook or memory does not.
   */
  note?(text: string): Promise<void>;
}

/** Fan out to every channel; one failing never stops the others or the run. */
export function channels(list: Channel[]): Channel {
  return {
    name: "all",
    async deliver(event, feed) {
      await Promise.allSettled(list.map((c) => c.deliver(event, feed)));
    },
    async note(text) {
      await Promise.allSettled(list.map((c) => c.note?.(text)));
    },
  };
}
