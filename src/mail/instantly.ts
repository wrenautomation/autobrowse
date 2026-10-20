/**
 * `InboxReader` over Instantly's email API for an inbox only Instantly holds: a fleet whose
 * Google logins stay with the vendor and are connected to Instantly by OAuth. Instantly syncs
 * every message those inboxes receive (`mode=emode_all`, warmup mail left out), so a caller
 * reads them without a login.
 *
 * Instantly keeps no raw message. Metadata is built in Gmail's shape from its fields and
 * `getRaw` writes a plain RFC 822 message from them. It carries no `In-Reply-To` or
 * `References`, so a reply here matches by its `From`.
 *
 * Ids are `instantly:<uuid>`: unique fleet wide.
 */
import type { FetchLike } from "../clients/http.js";
import type { InboxReader, MessageMetadata } from "./types.js";

const API = "https://api.instantly.ai/api/v2";
/** `ue_type` of a message the inbox received (1 = campaign send, 3 = manual send). */
const RECEIVED = 2;
const PAGE = 100;
const ID = "instantly:";

/** One message as Instantly's `/emails` lists it; read defensively. */
export interface InstantlyEmail {
  id: string;
  timestamp_email?: string | null;
  message_id?: string | null;
  subject?: string | null;
  from_address_email?: string | null;
  from_address_json?: { address?: string; name?: string }[] | null;
  to_address_email_list?: string | null;
  body?: { text?: string | null; html?: string | null } | null;
  eaccount?: string | null;
  ue_type?: number | null;
}

export interface InstantlyReaderOptions {
  apiKey: string;
  /** Test seam. */
  fetch?: FetchLike;
}

export class InstantlyReader implements InboxReader {
  private readonly fetch: FetchLike;
  /** The last listing's messages: the sync asks for each id right after. */
  private listed = new Map<string, InstantlyEmail>();

  constructor(private readonly opts: InstantlyReaderOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (!r.ok) throw new Error(`instantly: GET ${path.split("?")[0]} answered ${r.status}`);
    return (await r.json()) as T;
  }

  /** Every received message at or after the query's `after:<epoch seconds>`, newest first; one page, no token. */
  async listMessages(sender: string, query: string): Promise<[string[], string | null]> {
    const after = /after:(\d+)/.exec(query);
    const afterMs = after ? Number(after[1]) * 1000 : 0;
    const listed = new Map<string, InstantlyEmail>();
    let cursor: string | null = null;
    pages: do {
      const q = new URLSearchParams({ limit: String(PAGE), mode: "emode_all", eaccount: sender });
      if (cursor) q.set("starting_after", cursor);
      const page = await this.get<{
        items?: InstantlyEmail[];
        next_starting_after?: string | null;
      }>(`/emails?${q}`);
      for (const e of page.items ?? []) {
        if (timeOf(e) < afterMs) break pages;
        if (e.ue_type === RECEIVED) listed.set(`${ID}${e.id}`, e);
      }
      cursor = page.next_starting_after ?? null;
    } while (cursor);
    this.listed = listed;
    return [[...listed.keys()], null];
  }

  async getMetadata(sender: string, id: string): Promise<MessageMetadata> {
    return metadataOf(await this.email(sender, id));
  }

  async getRaw(sender: string, id: string): Promise<Uint8Array> {
    return new TextEncoder().encode(rawOf(await this.email(sender, id)));
  }

  private async email(sender: string, id: string): Promise<InstantlyEmail> {
    const cached = this.listed.get(id);
    if (cached) return cached;
    if (!id.startsWith(ID)) throw new Error(`instantly: ${id} is not an Instantly id`);
    const e = await this.get<InstantlyEmail>(`/emails/${encodeURIComponent(id.slice(ID.length))}`);
    if (e.eaccount && e.eaccount.toLowerCase() !== sender.toLowerCase())
      throw new Error(`instantly: ${id} is not a message of ${sender}`);
    return e;
  }
}

const timeOf = (e: InstantlyEmail): number => Date.parse(e.timestamp_email ?? "") || 0;

/** The From line, display name included when Instantly has one. */
function fromOf(e: InstantlyEmail): string {
  const first = e.from_address_json?.[0];
  const address = first?.address ?? e.from_address_email ?? "";
  return first?.name ? `"${first.name.replace(/"/g, "'")}" <${address}>` : address;
}

function headersOf(e: InstantlyEmail): [string, string][] {
  const out: [string, string][] = [
    ["From", fromOf(e)],
    ["To", e.to_address_email_list ?? e.eaccount ?? ""],
    ["Subject", e.subject ?? ""],
  ];
  const at = timeOf(e);
  if (at) out.push(["Date", new Date(at).toUTCString()]);
  if (e.message_id) out.push(["Message-ID", e.message_id]);
  return out.map(([k, v]) => [k, v.replace(/[\r\n]+/g, " ")]);
}

export function metadataOf(e: InstantlyEmail): MessageMetadata {
  const at = timeOf(e);
  return {
    payload: { headers: headersOf(e).map(([name, value]) => ({ name, value })) },
    internalDate: at ? String(at) : null,
    threadId: null,
  };
}

/** A plain-text RFC 822 message: Instantly's text body, else its HTML with the tags dropped. */
export function rawOf(e: InstantlyEmail): string {
  const text =
    e.body?.text ??
    (e.body?.html ?? "")
      .replace(/<(br|\/p|\/div)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ");
  const head = headersOf(e).map(([k, v]) => `${k}: ${v}`);
  head.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8");
  head.push("Content-Transfer-Encoding: 8bit");
  return `${head.join("\r\n")}\r\n\r\n${text.replace(/\r?\n/g, "\r\n")}`;
}
