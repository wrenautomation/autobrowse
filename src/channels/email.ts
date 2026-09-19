/** Gates and outcomes by mail, from a fleet inbox to the operator. */
import type { GmailUserClient } from "../clients/gmail.js";
import { render } from "./render.js";
import type { Channel } from "./types.js";

export function emailChannel(opts: { gmail: GmailUserClient; from: string; to: string }): Channel {
  return {
    name: "email",
    async deliver(event) {
      const r = render(event);
      if (!r) return;
      await opts.gmail.send({ from: opts.from, to: opts.to, subject: r.subject, text: r.text });
    },
  };
}
