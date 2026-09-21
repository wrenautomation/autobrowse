/** Gmail as one user (domain-wide delegation): the send-as signature, and plain mail for notifications. */
import { authedJson, type TokenSupplier } from "../google-auth.js";
import type { HttpClient } from "./http.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Bodies kept between polls; oldest out first. */
const SEEN_CAP = 200;

export interface GmailUserClient {
  /** The primary send-as signature; idempotent. */
  setSignature(email: string, html: string): Promise<"set" | "kept">;
  send(mail: { from: string; to: string; subject: string; text: string }): Promise<void>;
  /** Messages in `inbox` received after `since`, newest first; for one-time codes. */
  recent(inbox: string, since: Date): Promise<GmailMessage[]>;
}

export interface GmailMessage {
  from: string;
  subject: string;
  text: string;
  at: Date;
}

interface RawMessage {
  id: string;
  internalDate?: string;
  snippet?: string;
  payload?: RawPart;
}
interface RawPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: RawPart[];
}

/** Plain text of a message: text/plain parts first, else HTML with tags stripped, else the snippet. */
export function messageText(m: RawMessage): string {
  const texts: string[] = [];
  const htmls: string[] = [];
  const walk = (p: RawPart | undefined) => {
    if (!p) return;
    const data = p.body?.data;
    if (data) {
      const s = Buffer.from(data, "base64url").toString("utf8");
      if (p.mimeType === "text/plain") texts.push(s);
      else if (p.mimeType === "text/html") htmls.push(s);
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(m.payload);
  if (texts.length) return texts.join("\n");
  if (htmls.length)
    return htmls
      .join("\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  return m.snippet ?? "";
}

export class GmailError extends Error {
  constructor(what: string, status: number, body: unknown) {
    const detail = (body as { error?: { message?: string } } | null)?.error?.message ?? "";
    super(`gmail ${what}: HTTP ${status} ${detail}`.trim());
    this.name = "GmailError";
  }
}

/** `tokenFor(user)` mints a supplier acting as that user with the scopes the call needs. */
export function gmailClient(opts: {
  tokenFor: (user: string, scopes: readonly string[]) => TokenSupplier;
  scopes: { settings: string; send: string; read: string };
  http: HttpClient;
}): GmailUserClient {
  // Bodies by inbox and message id; a message never changes once it landed.
  const seen = new Map<string, GmailMessage>();
  return {
    async setSignature(email, html) {
      const token = opts.tokenFor(email, [opts.scopes.settings]);
      const url = `${GMAIL}/settings/sendAs/${encodeURIComponent(email)}`;
      const current = await authedJson<{ signature?: string }>(opts.http, token, url);
      if (current.status >= 400) throw new GmailError("get sendAs", current.status, current.body);
      if ((current.body?.signature ?? "") === html) return "kept";
      const r = await authedJson(opts.http, token, url, {
        method: "PATCH",
        body: { signature: html },
      });
      if (r.status >= 400) throw new GmailError("set signature", r.status, r.body);
      return "set";
    },
    async send(mail) {
      const token = opts.tokenFor(mail.from, [opts.scopes.send]);
      const raw = [
        `From: ${mail.from}`,
        `To: ${mail.to}`,
        `Subject: ${mail.subject}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        mail.text,
      ].join("\r\n");
      const r = await authedJson(opts.http, token, `${GMAIL}/messages/send`, {
        method: "POST",
        body: { raw: Buffer.from(raw).toString("base64url") },
      });
      if (r.status >= 400) throw new GmailError("send", r.status, r.body);
    },
    async recent(inbox, since) {
      const token = opts.tokenFor(inbox, [opts.scopes.read]);
      const q = encodeURIComponent(`after:${Math.floor(since.getTime() / 1000)}`);
      const list = await authedJson<{ messages?: Array<{ id: string }> }>(
        opts.http,
        token,
        // A code that landed in spam is still the code.
        `${GMAIL}/messages?q=${q}&maxResults=10&includeSpamTrash=true`,
      );
      if (list.status >= 400) throw new GmailError("list", list.status, list.body);
      // A poll every few seconds lists the same ids: each body is fetched once, all at once.
      const got = await Promise.all(
        (list.body?.messages ?? []).map(async ({ id }): Promise<GmailMessage | null> => {
          const key = `${inbox}\u0000${id}`;
          const kept = seen.get(key);
          if (kept) return kept;
          const m = await authedJson<RawMessage>(
            opts.http,
            token,
            `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`,
          );
          if (m.status >= 400 || !m.body) return null;
          const header = (name: string) =>
            m.body?.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
          const msg: GmailMessage = {
            from: header("from"),
            subject: header("subject"),
            text: messageText(m.body),
            at: new Date(Number(m.body.internalDate ?? 0)),
          };
          if (seen.size >= SEEN_CAP) seen.delete(seen.keys().next().value as string);
          seen.set(key, msg);
          return msg;
        }),
      );
      return got
        .filter((m): m is GmailMessage => m !== null)
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    },
  };
}
