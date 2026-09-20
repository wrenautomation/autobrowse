/**
 * Linq: iMessage (then RCS, then SMS) from a number we own, without a
 * Mac. One client sends to the operator and reads what comes back, the
 * same `MessageReader` shape the code sources poll. The key rides in the
 * Authorization header, never a URL. Webhooks are verified the Standard
 * Webhooks way (HMAC-SHA256 over `id.timestamp.body`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Message, MessageReader } from "../auth/codes.js";
import type { HttpClient } from "./http.js";

export const LINQ_API = "https://api.linqapp.com";

const part = z.object({ type: z.string(), value: z.string().optional() }).passthrough();
const message = z
  .object({
    id: z.string().or(z.number()).transform(String),
    chat_id: z.string().or(z.number()).transform(String).optional(),
    from: z.string().optional(),
    parts: z.array(part).default([]),
    created_at: z.string().optional(),
  })
  .passthrough();
export type LinqMessage = z.infer<typeof message>;

/** Either `{messages: [...]}` or a bare list; both seen across API versions. */
const messageList = z
  .union([z.array(message), z.object({ messages: z.array(message) }).passthrough()])
  .transform((v) => (Array.isArray(v) ? v : v.messages));

const sendReply = z
  .object({ chat_id: z.string().or(z.number()).transform(String).optional() })
  .passthrough();

/** The inbound webhook envelope; the message sits in `data`. */
export const linqEvent = z.object({ type: z.string(), data: message }).passthrough();
export type LinqEvent = z.infer<typeof linqEvent>;

export function textOf(m: Pick<LinqMessage, "parts">): string {
  return m.parts
    .filter((p) => p.type === "text" && p.value)
    .map((p) => p.value as string)
    .join("\n");
}

export interface LinqOptions {
  apiKey: string;
  /** Our number (E.164): what the operator sees messages from. */
  from: string;
  http: HttpClient;
  baseUrl?: string;
}

export interface LinqClient {
  /** Text `to` (E.164). The chat is created on first use and remembered. */
  send(to: string, text: string): Promise<void>;
  /** Messages in the chat with `to` since `since`, newest first, ours excluded. */
  recent(to: string, since: Date): Promise<Message[]>;
  /** Learn a chat id from an inbound event so replies reuse it. */
  learn(to: string, chatId: string): void;
  reader(): MessageReader;
}

export function linqClient(opts: LinqOptions): LinqClient {
  const base = opts.baseUrl ?? LINQ_API;
  const headers = { authorization: `Bearer ${opts.apiKey}` };
  const chats = new Map<string, string>();
  const post = async <T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> => {
    const r = await opts.http.json<unknown>(`${base}${path}`, { method: "POST", headers, body });
    if (r.status >= 400) throw new Error(`linq ${path}: HTTP ${r.status}`);
    return schema.parse(r.body);
  };
  const client: LinqClient = {
    learn: (to, chatId) => void chats.set(to, chatId),
    async send(to, text) {
      const parts = [{ type: "text", value: text.slice(0, 10_000) }];
      const chat = chats.get(to);
      if (chat) {
        await post(
          `/v3/chats/${encodeURIComponent(chat)}/messages`,
          { message: { parts } },
          sendReply,
        );
        return;
      }
      const r = await post(
        "/v3/chats",
        { from: opts.from, to: [to], message: { parts } },
        sendReply,
      );
      if (r.chat_id) chats.set(to, r.chat_id);
    },
    async recent(to, since) {
      const chat = chats.get(to);
      if (!chat) return [];
      const r = await opts.http.json<unknown>(
        `${base}/v3/chats/${encodeURIComponent(chat)}/messages`,
        { headers },
      );
      if (r.status >= 400) throw new Error(`linq messages: HTTP ${r.status}`);
      return messageList
        .parse(r.body)
        .filter((m) => m.from !== opts.from)
        .map((m) => ({
          from: m.from ?? to,
          subject: "",
          text: textOf(m),
          at: new Date(m.created_at ?? 0),
        }))
        .filter((m) => m.at.getTime() >= since.getTime())
        .sort((a, b) => b.at.getTime() - a.at.getTime());
    },
    reader: () => ({ recent: (inbox, since) => client.recent(inbox, since) }),
  };
  return client;
}

export interface WebhookHeaders {
  "webhook-id"?: string | undefined;
  "webhook-timestamp"?: string | undefined;
  "webhook-signature"?: string | undefined;
}

const TOLERANCE_S = 300;

/** Standard Webhooks check; `secret` may carry the `whsec_` prefix. False on anything off. */
export function verifyLinqWebhook(
  headers: WebhookHeaders,
  body: string,
  secret: string,
  now: () => number = Date.now,
): boolean {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sig = headers["webhook-signature"];
  if (!id || !ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now() / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest();
  return sig.split(/\s+/).some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Sign the way Linq does; for tests and for a local sender. */
export function signLinqWebhook(id: string, ts: string, body: string, secret: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}
