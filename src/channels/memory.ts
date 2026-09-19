/**
 * What people say at hand-offs, and where flows needed them, go to
 * memory: the next compile or repair on that site can recall it. Only
 * notes and step details are written; prompts are the system's own words.
 */
import type { Memory } from "../memory/types.js";
import type { Channel } from "./types.js";

export function memoryChannel(memory: Memory): Channel {
  return {
    name: "memory",
    async deliver(event) {
      const run = `${event.run.workflow}/${event.run.key}`;
      if (event.type === "gate-answered" && event.note) {
        await memory.remember(
          `workflow=${event.run.workflow} step=${event.step} gate=${event.gate} ${event.approved ? "approved" : "rejected"}: ${event.note}`,
          { workflow: event.run.workflow, step: event.step, kind: "hand-off", run },
        );
      } else if (event.type === "step" && event.result.status === "needs-human") {
        await memory.remember(
          `workflow=${event.run.workflow} step=${event.step} needed a person: ${event.result.detail}`,
          { workflow: event.run.workflow, step: event.step, kind: "needs-human", run },
        );
      }
    },
  };
}
