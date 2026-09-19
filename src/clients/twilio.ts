/**
 * One Twilio number we own, read for one-time codes. Same shape as the
 * Gmail reader, so `messageSource({ kind: "sms" })` polls it. Basic auth
 * goes in the header, never the URL.
 */
import type { MessageReader } from "../auth/codes.js";
import type { HttpClient } from "./http.js";

const API = "https://api.twilio.com/2010-04-01";

interface RawSms {
  from: string;
  body: string;
  date_sent: string | null;
  date_created: string;
}

export function twilioReader(opts: {
  accountSid: string;
  authToken: string;
  http: HttpClient;
}): MessageReader {
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;
  return {
    async recent(inbox, since) {
      const day = since.toISOString().slice(0, 10);
      const url = `${API}/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json?To=${encodeURIComponent(inbox)}&DateSent%3E=${day}&PageSize=20`;
      const r = await opts.http.json<{ messages?: RawSms[] }>(url, {
        headers: { authorization: auth },
      });
      if (r.status >= 400) throw new Error(`twilio list: HTTP ${r.status}`);
      return (r.body?.messages ?? [])
        .map((m) => ({
          from: m.from,
          subject: "",
          text: m.body,
          at: new Date(m.date_sent ?? m.date_created),
        }))
        .filter((m) => m.at.getTime() >= since.getTime())
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    },
  };
}
