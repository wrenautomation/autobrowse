/**
 * A channel delivers run events to people and systems, and turns what
 * they say back into commands. Email, a webhook, iMessage: same shape.
 */
import type { RunEvent } from "../engine/events.js";

export interface Channel {
  name: string;
  deliver(event: RunEvent): Promise<void>;
}

/** Fan out to every channel; one failing never stops the others or the run. */
export function channels(list: Channel[]): Channel {
  return {
    name: "all",
    async deliver(event) {
      await Promise.allSettled(list.map((c) => c.deliver(event)));
    },
  };
}
