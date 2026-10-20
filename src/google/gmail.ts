/**
 * Gmail over domain-wide delegation: the wire (`GmailClient`) and, on top of it, one-user helpers
 * (`gmailClient`: send-as signature, plain mail, recent codes, search, whole messages).
 * `GmailClient` is dumb transport (bytes in, provider objects out, loud `GmailApiError` on any
 * non-2xx, fetch failures passed through untouched). It adds no time limit and no retry: a caller
 * that needs either wraps its `fetch`.
 */
import libmime from "libmime";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { FetchLike } from "../clients/http.js";
import {
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  loadServiceAccountKey,
  type ServiceAccountKey,
  ServiceAccountKeyError,
  serviceAccountToken,
  type TokenSupplier,
} from "./auth.js";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** What the outbox needs end to end: send, then read the same mailbox back. */
export const SEND_AND_READ_SCOPES: readonly string[] = [GMAIL_SEND_SCOPE, GMAIL_MODIFY_SCOPE];

/** A non-2xx from the Gmail API. The bearer travels in a header, so the excerpt is safe to print. */
export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    readonly sender: string,
  ) {
    super(`gmail HTTP ${status} for ${sender}: ${bodyExcerpt}`);
    this.name = "GmailApiError";
  }
}

function excerptOf(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (message !== undefined) return String(message).slice(0, 200);
  } catch {
    // not JSON
  }
  return text.slice(0, 200);
}

export type Json = Record<string, unknown>;

export interface GmailClientOptions {
  /** Path of the service-account JSON key; read lazily, only when a real token is minted. */
  keyPath?: string;
  /** The env var `keyPath` came from, named in a key error (default `GOOGLE_SERVICE_ACCOUNT`). */
  keyEnv?: string;
  key?: ServiceAccountKey;
  /** Every Gmail call, the token exchange too, goes through this; no time limit or retry is added here. */
  fetch?: FetchLike;
  scopes?: readonly string[];
  /** Seam for tests: the sender address → its bearer supplier. */
  tokenFactory?: (sender: string) => TokenSupplier;
}

/** Gmail publishes only to a topic in the API client's own project: the service account's. */
export const gmailPushTopic = (clientEmail: string): string =>
  `projects/${clientEmail.split("@")[1]?.split(".")[0]}/topics/gmail-push`;

/**
 * Gmail REST for one service-account key, acting as many senders. One token
 * supplier is cached per sender (never the bearer string): it refreshes
 * itself on expiry, so a long loop mints one exchange per inbox per hour.
 */
export class GmailClient {
  private readonly fetch: FetchLike;
  private readonly tokenFactory: (sender: string) => TokenSupplier;
  private readonly tokens = new Map<string, TokenSupplier>();

  constructor(opts: GmailClientOptions) {
    // The token exchange goes through the same fetch as every Gmail call.
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    const scopes = opts.scopes ?? SEND_AND_READ_SCOPES;
    let key = opts.key ?? null;
    this.tokenFactory =
      opts.tokenFactory ??
      ((sender) => {
        if (key === null) {
          if (!opts.keyPath)
            throw new ServiceAccountKeyError(
              "GmailClient needs a key, a keyPath or a tokenFactory",
            );
          key = loadServiceAccountKey(opts.keyPath, opts.keyEnv);
        }
        return serviceAccountToken(key, { scopes, subject: sender, fetch: this.fetch });
      });
  }

  private supplier(sender: string): TokenSupplier {
    let supplier = this.tokens.get(sender);
    if (!supplier) {
      supplier = this.tokenFactory(sender);
      this.tokens.set(sender, supplier);
    }
    return supplier;
  }

  /** Mint (or refresh) this sender's token without sending anything. */
  async ensureToken(sender: string): Promise<void> {
    await this.supplier(sender)();
  }

  private async request(
    method: "GET" | "POST" | "PATCH",
    sender: string,
    path: string,
    opts: { params?: Record<string, string | string[]>; json?: Json } = {},
  ): Promise<Json> {
    const url = new URL(`${GMAIL_API}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    }
    const token = await this.supplier(sender)();
    const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
    if (opts.json !== undefined) {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = JSON.stringify(opts.json);
    }
    const response = await this.fetch(url.toString(), init);
    const text = await response.text();
    if (response.status >= 400) throw new GmailApiError(response.status, excerptOf(text), sender);
    return JSON.parse(text) as Json;
  }

  /** POST one RFC 5322 message as `sender`; `threadId` files it inside that conversation. */
  sendRaw(sender: string, mime: Buffer, threadId?: string | null): Promise<Json> {
    const json: Json = { raw: mime.toString("base64url") };
    if (threadId) json.threadId = threadId;
    return this.request("POST", sender, "/messages/send", { json });
  }

  /** `{id, threadId, internalDate}` for OUR Message-ID in this mailbox, or null. */
  async findByMessageId(
    sender: string,
    messageId: string,
  ): Promise<{ id: string; threadId: string; internalDate: string | null } | null> {
    const listed = await this.request("GET", sender, "/messages", {
      params: { q: `rfc822msgid:${messageId.trim().replace(/^<|>$/g, "")}`, maxResults: "1" },
    });
    const messages = (listed.messages as Array<{ id: string }> | undefined) ?? [];
    const first = messages[0];
    if (!first) return null;
    let found: Json;
    try {
      found = await this.request("GET", sender, `/messages/${first.id}`, {
        params: { format: "metadata", metadataHeaders: ["Message-ID"] },
      });
    } catch (err) {
      if (err instanceof GmailApiError && err.status === 404) return null;
      throw err;
    }
    return {
      id: String(found.id),
      threadId: String(found.threadId),
      internalDate: found.internalDate === undefined ? null : String(found.internalDate),
    };
  }

  /** One page of message ids for a Gmail search plus the next page token. */
  async listMessages(
    sender: string,
    query: string,
    opts: { pageToken?: string | null; maxResults?: number; includeSpamTrash?: boolean } = {},
  ): Promise<[string[], string | null]> {
    const params: Record<string, string> = { q: query, maxResults: String(opts.maxResults ?? 100) };
    if (opts.pageToken) params.pageToken = opts.pageToken;
    if (opts.includeSpamTrash) params.includeSpamTrash = "true";
    const data = await this.request("GET", sender, "/messages", { params });
    const messages = (data.messages as Array<{ id: string }> | undefined) ?? [];
    return [
      messages.map((m) => m.id),
      typeof data.nextPageToken === "string" ? data.nextPageToken : null,
    ];
  }

  /** The API's own object for one message, headers only. */
  getMetadata(sender: string, messageId: string, headers: readonly string[]): Promise<Json> {
    return this.request("GET", sender, `/messages/${messageId}`, {
      params: { format: "metadata", metadataHeaders: [...headers] },
    });
  }

  /** Gmail pushes this inbox's changes to `topicName` (Pub/Sub); returns when the watch lapses (ms). */
  async watch(sender: string, topicName: string): Promise<number> {
    const r = await this.request("POST", sender, "/watch", {
      json: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
    });
    return Number(r.expiration);
  }

  /** Every message id a Gmail search matches: `listMessages` in pages of 100 until no page token is left. */
  async searchAll(sender: string, query: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | null = null;
    do {
      const [page, next]: [string[], string | null] = await this.listMessages(sender, query, {
        pageToken,
        maxResults: 100,
      });
      ids.push(...page);
      pageToken = next;
    } while (pageToken);
    return ids;
  }

  /** The API's own object for one message, `full` (parts decoded by the caller) or `raw` (base64url RFC 5322). */
  getMessage(sender: string, messageId: string, format: "full" | "raw"): Promise<Json> {
    return this.request("GET", sender, `/messages/${messageId}`, { params: { format } });
  }

  /** The send-as entry for `email` (its signature among the rest). */
  sendAs(sender: string, email: string): Promise<Json> {
    return this.request("GET", sender, `/settings/sendAs/${encodeURIComponent(email)}`);
  }

  /** Change fields of the send-as entry for `email`. */
  patchSendAs(sender: string, email: string, body: Json): Promise<Json> {
    return this.request("PATCH", sender, `/settings/sendAs/${encodeURIComponent(email)}`, {
      json: body,
    });
  }

  /** The full RFC 5322 message as bytes. */
  async getRaw(sender: string, messageId: string): Promise<Buffer> {
    const data = await this.request("GET", sender, `/messages/${messageId}`, {
      params: { format: "raw" },
    });
    return Buffer.from(String(data.raw), "base64url");
  }
}

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

/** A header from raw RFC 822 text (folded lines joined, RFC 2047 words decoded by libmime); "" when absent. */
export function rawHeader(raw: Buffer, name: string): string {
  const head = raw.toString("utf8").split(/\r?\n\r?\n/)[0] ?? "";
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, "im");
  const value = re.exec(unfolded)?.[1]?.trim() ?? "";
  try {
    return libmime.decodeWords(value);
  } catch {
    return value;
  }
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

/**
 * `tokenFor(user, scopes)` mints a supplier acting as that user with the scopes the call needs.
 * One `GmailClient` per scope does the wire; a non-2xx is a `GmailApiError`.
 */
export function gmailClient(opts: {
  tokenFor: (user: string, scopes: readonly string[]) => TokenSupplier;
  scopes: { settings: string; send: string; read: string };
  fetch?: FetchLike;
}): GmailUserClient {
  const wire = (scope: string) =>
    new GmailClient({
      tokenFactory: (user) => opts.tokenFor(user, [scope]),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  const settings = wire(opts.scopes.settings);
  const sender = wire(opts.scopes.send);
  const reader = wire(opts.scopes.read);
  // A message the API will not give (gone, refused) is left out of a listing, not a failure of it.
  const orNull = async <T>(get: Promise<T>): Promise<T | null> =>
    get.catch((err: unknown) => {
      if (err instanceof GmailApiError) return null;
      throw err;
    });
  // Bodies by inbox and message id; a message never changes once it landed.
  const seen = new Map<string, GmailMessage>();
  return {
    async setSignature(email, html) {
      const current = await settings.sendAs(email, email);
      if (String(current.signature ?? "") === html) return "kept";
      await settings.patchSendAs(email, email, { signature: html });
      return "set";
    },
    async send(mail) {
      const raw = await mimeMessage(mail);
      await sender.sendRaw(mail.from, Buffer.from(raw));
    },
    async recent(inbox, since) {
      // A code that landed in spam is still the code.
      const [ids] = await reader.listMessages(
        inbox,
        `after:${Math.floor(since.getTime() / 1000)}`,
        {
          maxResults: 10,
          includeSpamTrash: true,
        },
      );
      // A poll every few seconds lists the same ids: each body is fetched once, all at once.
      const got = await Promise.all(
        ids.map(async (id): Promise<GmailMessage | null> => {
          const key = `${inbox}\u0000${id}`;
          const kept = seen.get(key);
          if (kept) return kept;
          const m = (await orNull(reader.getMessage(inbox, id, "full"))) as RawMessage | null;
          if (!m) return null;
          const msg: GmailMessage = {
            from: headerOf(m, "from"),
            subject: headerOf(m, "subject"),
            text: messageText(m),
            at: new Date(Number(m.internalDate ?? 0)),
          };
          if (seen.size >= SEEN_CAP) seen.delete(seen.keys().next().value as string);
          seen.set(key, msg);
          return msg;
        }),
      );
      return newestFirst(got);
    },
    async search(inbox, query, max = 20) {
      const [ids] = await reader.listMessages(inbox, query, {
        maxResults: max,
        includeSpamTrash: true,
      });
      const got = await Promise.all(
        ids.map(async (id): Promise<GmailMessage | null> => {
          const m = (await orNull(
            reader.getMetadata(inbox, id, ["From", "Subject"]),
          )) as RawMessage | null;
          if (!m) return null;
          return {
            from: headerOf(m, "from"),
            subject: headerOf(m, "subject"),
            text: "",
            at: new Date(Number(m.internalDate ?? 0)),
          };
        }),
      );
      return newestFirst(got);
    },
    async whole(inbox, query, max = 5) {
      const [ids] = await reader.listMessages(inbox, query, { maxResults: max });
      const got = await Promise.all(
        ids.map(async (id): Promise<WholeMessage | null> => {
          const m = await orNull(reader.getMessage(inbox, id, "raw"));
          if (!m || typeof m.raw !== "string" || !m.raw) return null;
          const raw = Buffer.from(m.raw, "base64url");
          return {
            from: rawHeader(raw, "from"),
            subject: rawHeader(raw, "subject"),
            at: new Date(Number(m.internalDate ?? 0)),
            raw,
          };
        }),
      );
      return newestFirst(got);
    },
  };
}

const headerOf = (m: RawMessage, name: string): string =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";

function newestFirst<T extends { at: Date }>(got: (T | null)[]): T[] {
  return got.filter((m): m is T => m !== null).sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * RFC 5322 text, or multipart/mixed when there are files, by nodemailer's
 * composer: header values with CR/LF stay one header, non-ASCII subjects and
 * file names are encoded words, and no file or URL is ever read.
 */
export async function mimeMessage(mail: Parameters<GmailUserClient["send"]>[0]): Promise<string> {
  const composer = new MailComposer({
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachments?.map((a) => ({
      filename: a.name,
      contentType: a.type,
      content: a.data,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const built = await composer.compile().build();
  return built.toString("utf8");
}
