/** Every event as JSON to one URL. iMessage (Linq), Slack, a dashboard: all webhook-shaped on the way out. */
import type { HttpClient } from "../clients/http.js";
import { render } from "./render.js";
import type { Channel } from "./types.js";

export function webhookChannel(opts: {
  url: string;
  http: HttpClient;
  /** Sent as a bearer; never logged. */
  token?: string;
}): Channel {
  return {
    name: "webhook",
    async deliver(event) {
      await opts.http.json(opts.url, {
        method: "POST",
        headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
        body: { event, rendered: render(event) },
      });
    },
  };
}
