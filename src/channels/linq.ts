/** Run events as iMessages through Linq: the open gate, the failure, the finish. */
import type { LinqClient } from "../clients/linq.js";
import { render } from "./render.js";
import type { Channel } from "./types.js";

export function linqChannel(opts: { client: LinqClient; to: string }): Channel {
  return {
    name: "linq",
    async deliver(event) {
      const r = render(event);
      if (!r) return;
      await opts.client.send(opts.to, `${r.subject}\n${r.text}`.trim());
    },
    note: (text) => opts.client.send(opts.to, text),
  };
}
