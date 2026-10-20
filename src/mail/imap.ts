/**
 * `InboxReader` over IMAP for an inbox on its own login.
 * Reads INBOX and spam (the `\Junk` folder) only, both opened read-only and fetched
 * with BODY.PEEK, so no message is ever marked read. Metadata comes back in Gmail's
 * shape, so the sync reads both kinds of inbox the same way.
 *
 * Ids are `<inbox|spam>:<uidvalidity>:<uid>:<sender tag>`. The tag (a hash of the
 * address) keeps them unique across inboxes: `thread_events.gmail_id` is unique fleet
 * wide, and two inboxes on one host can share a UIDVALIDITY. A folder whose
 * UIDVALIDITY changed no longer holds the id, so reading it is an error.
 */
import { createHash } from "node:crypto";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import { imapClient, inFolder, type Login, specialFolder, withImap } from "./session.js";
import { type InboxReader, METADATA_HEADERS, type MessageMetadata } from "./types.js";

type Tag = "inbox" | "spam";

const senderTag = (sender: string): string =>
  createHash("sha256").update(sender.toLowerCase()).digest("hex").slice(0, 8);

/** Unfolded header lines as Gmail's `payload.headers`. */
export function headerList(raw: Buffer | undefined): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const line of (raw?.toString("utf8") ?? "").replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0)
      out.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

const metadataOf = (msg: FetchMessageObject): MessageMetadata => ({
  payload: { headers: headerList(msg.headers) },
  internalDate:
    msg.internalDate === undefined ? null : String(new Date(msg.internalDate).getTime()),
  threadId: null,
});

export interface ImapReaderOptions {
  /** Test seam: the client for a login. */
  imap?: (login: Login) => ImapFlow;
}

export class ImapReader implements InboxReader {
  private readonly client: (login: Login) => ImapFlow;
  /** The last listing's metadata: the sync asks for each id right after. */
  private listed = new Map<string, MessageMetadata>();

  constructor(
    private readonly login: Login,
    opts: ImapReaderOptions = {},
  ) {
    this.client = opts.imap ?? imapClient;
  }

  /** Everything at or after the query's `after:<epoch seconds>`; one page, no token. */
  async listMessages(sender: string, query: string): Promise<[string[], string | null]> {
    const after = /after:(\d+)/.exec(query);
    const afterMs = after ? Number(after[1]) * 1000 : 0;
    // SINCE is a whole day in the server's zone: ask from the day before, keep what is after.
    const since = new Date(afterMs - 86_400_000);
    const listed = new Map<string, MessageMetadata>();
    await withImap(this.client(this.login), async (client) => {
      for (const [tag, path] of await folders(client)) {
        await inFolder(client, path, async (uidValidity) => {
          const found = await client.fetchAll(
            { since },
            { uid: true, internalDate: true, headers: [...METADATA_HEADERS] },
            { uid: true },
          );
          for (const msg of found) {
            const metadata = metadataOf(msg);
            if (Number(metadata.internalDate ?? afterMs) < afterMs) continue;
            listed.set(`${tag}:${uidValidity}:${msg.uid}:${senderTag(sender)}`, metadata);
          }
        });
      }
    });
    this.listed = listed;
    return [[...listed.keys()], null];
  }

  async getMetadata(sender: string, id: string): Promise<MessageMetadata> {
    const cached = this.listed.get(id);
    if (cached) return cached;
    const msg = await this.fetch(sender, id, {
      uid: true,
      internalDate: true,
      headers: [...METADATA_HEADERS],
    });
    return metadataOf(msg);
  }

  async getRaw(sender: string, id: string): Promise<Uint8Array> {
    const msg = await this.fetch(sender, id, { uid: true, source: true });
    if (!msg.source) throw new Error(`imap: ${id} came back without a body`);
    return new Uint8Array(msg.source);
  }

  private fetch(
    sender: string,
    id: string,
    query: Parameters<ImapFlow["fetchOne"]>[1],
  ): Promise<FetchMessageObject> {
    const [tag, validity, uid, owner] = id.split(":");
    if (owner !== senderTag(sender) || (tag !== "inbox" && tag !== "spam") || !uid) {
      throw new Error(`imap: ${id} is not an id from ${sender}`);
    }
    return withImap(this.client(this.login), async (client) => {
      const path = (await folders(client)).get(tag);
      if (!path) throw new Error(`imap: ${sender} has no ${tag} folder`);
      return inFolder(client, path, async (uidValidity) => {
        if (uidValidity !== validity)
          throw new Error(`imap: ${path} was renumbered; ${id} is gone`);
        const msg = await client.fetchOne(uid, query, { uid: true });
        if (!msg) throw new Error(`imap: ${id} is gone`);
        return msg;
      });
    });
  }
}

/** INBOX, and spam when the server flags one. */
async function folders(client: ImapFlow): Promise<Map<Tag, string>> {
  const out = new Map<Tag, string>([["inbox", "INBOX"]]);
  const junk = await specialFolder(client, "\\Junk");
  if (junk) out.set("spam", junk);
  return out;
}

/** Each sender's own reader, else the fallback (Gmail). */
export class RoutedReader implements InboxReader {
  constructor(
    private readonly fallback: InboxReader,
    private readonly routes: ReadonlyMap<string, InboxReader>,
  ) {}

  private readerOf(sender: string): InboxReader {
    return this.routes.get(sender.toLowerCase()) ?? this.fallback;
  }

  listMessages(...args: Parameters<InboxReader["listMessages"]>) {
    return this.readerOf(args[0]).listMessages(...args);
  }
  getMetadata(...args: Parameters<InboxReader["getMetadata"]>) {
    return this.readerOf(args[0]).getMetadata(...args);
  }
  getRaw(...args: Parameters<InboxReader["getRaw"]>) {
    return this.readerOf(args[0]).getRaw(...args);
  }
}
