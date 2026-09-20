/** Run events as iMessages to the paired phone: the open gate, the failure, the finish. */
import { type PhoneOptions, phoneNotifier } from "../devices/phone.js";
import { render } from "./render.js";
import type { Channel } from "./types.js";

export function phoneChannel(opts: PhoneOptions): Channel {
  const notify = phoneNotifier(opts);
  return {
    name: "phone",
    async deliver(event) {
      const r = render(event);
      if (!r) return;
      await notify(`${r.subject}\n${r.text}`.trim());
    },
    note: notify,
  };
}
