/** Gmail as one user (domain-wide delegation): the send-as signature, and plain mail for notifications. */
import { authedJson, type TokenSupplier } from "../google-auth.js";
import type { HttpClient } from "./http.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Bodies kept between polls; oldest out first. */
const SEEN_CAP = 200;

export interface GmailUserClient {
  /** The primary send-as signature; idempotent. */
  setSignature(email: string, html: string): Promise<"set" | "kept">;
  send(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    /** Files after the text (a receipt screenshot): multipart/mixed. */
    attachments?: { name: string; type: string; data: Buffer }[];
  }): Promise<void>;
  /** Messages in `inbox` received after `since`, newest first; for one-time codes. */
  recent(inbox: string, since: Date): Promise<GmailMessage[]>;
  /**
   * Headers of the messages matching a Gmail query, newest first, however
   * old: "has this inbox ever heard from this sender" (`text` is empty —
   * the question is who wrote and when, never what they said).
   */
  search(inbox: string, query: string, max?: number): Promise<GmailMessage[]>;
  /** Whole messages (RFC 822, attachments and all) matching a query, newest first: to forward one as a file. */
  whole(inbox: string, query: string, max?: number): Promise<WholeMessage[]>;
}

export interface WholeMessage {
  from: string;
  subject: string;
  at: Date;
  /** The message as sent: attach it as `message/rfc822`. */
  raw: Buffer;
}

/** A header from raw RFC 822 text (folded lines joined); "" when absent. */
export function rawHeader(raw: Buffer, name: string): string {
  const head = raw.toString("utf8").split(/\r?\n\r?\n/)[0] ?? "";
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, "im");
  return re.exec(unfolded)?.[1]?.trim() ?? "";
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
  // An HTML-only mail keeps its link targets (a confirm button) and drops its CSS.
  if (htmls.length)
    return htmls
      .join("\n")
      .replace(/<(style|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, " $1 ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
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
      const raw = mimeMessage(mail);
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
    async search(inbox, query, max = 20) {
      const token = opts.tokenFor(inbox, [opts.scopes.read]);
      const list = await authedJson<{ messages?: Array<{ id: string }> }>(
        opts.http,
        token,
        `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=${max}&includeSpamTrash=true`,
      );
      if (list.status >= 400) throw new GmailError("list", list.status, list.body);
      const got = await Promise.all(
        (list.body?.messages ?? []).map(async ({ id }): Promise<GmailMessage | null> => {
          const m = await authedJson<RawMessage>(
            opts.http,
            token,
            `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          );
          if (m.status >= 400 || !m.body) return null;
          const header = (name: string) =>
            m.body?.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
          return {
            from: header("from"),
            subject: header("subject"),
            text: "",
            at: new Date(Number(m.body.internalDate ?? 0)),
          };
        }),
      );
      return got
        .filter((m): m is GmailMessage => m !== null)
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    },
    async whole(inbox, query, max = 5) {
      const token = opts.tokenFor(inbox, [opts.scopes.read]);
      const list = await authedJson<{ messages?: Array<{ id: string }> }>(
        opts.http,
        token,
        `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
      );
      if (list.status >= 400) throw new GmailError("list", list.status, list.body);
      const got = await Promise.all(
        (list.body?.messages ?? []).map(async ({ id }): Promise<WholeMessage | null> => {
          const m = await authedJson<{ raw?: string; internalDate?: string }>(
            opts.http,
            token,
            `${GMAIL}/messages/${encodeURIComponent(id)}?format=raw`,
          );
          if (m.status >= 400 || !m.body?.raw) return null;
          const raw = Buffer.from(m.body.raw, "base64url");
          return {
            from: rawHeader(raw, "from"),
            subject: rawHeader(raw, "subject"),
            at: new Date(Number(m.body.internalDate ?? 0)),
            raw,
          };
        }),
      );
      return got
        .filter((m): m is WholeMessage => m !== null)
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    },
  };
}

/** RFC 5322 text, or multipart/mixed when there are files; base64 lines of 76. */
export function mimeMessage(mail: Parameters<GmailUserClient["send"]>[0]): string {
  const head = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    "MIME-Version: 1.0",
  ];
  const text = ['Content-Type: text/plain; charset="UTF-8"', "", mail.text];
  if (!mail.attachments?.length) return [...head, ...text].join("\r\n");
  const b = `autobrowse-${Date.now().toString(36)}`;
  const parts = mail.attachments.map((a) =>
    [
      `--${b}`,
      `Content-Type: ${a.type}; name="${a.name}"`,
      `Content-Disposition: attachment; filename="${a.name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      ...(a.data.toString("base64").match(/.{1,76}/g) ?? []),
    ].join("\r\n"),
  );
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    ...text,
    ...parts,
    `--${b}--`,
  ].join("\r\n");
}
