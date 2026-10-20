/**
 * The read half of a mailbox, as a reply sync sees it. Gmail, IMAP and Instantly all answer
 * in this shape (Gmail's), so one sync reads every kind of inbox the same way.
 */

/**
 * The cheap read: exactly the headers the classification and the match need,
 * so the sync never pulls a body it has no use for. Stored verbatim on the
 * event as the evidence behind its verdict.
 */
export const METADATA_HEADERS = [
  "Message-ID",
  "In-Reply-To",
  "References",
  "From",
  "Subject",
  "Date",
  "Auto-Submitted",
  "X-Autoreply",
  "X-Autorespond",
  "X-Auto-Response-Suppress",
  "Precedence",
  "Content-Type",
  "X-Failed-Recipients",
] as const;

/** The provider's message object, read defensively: shapes are Gmail's, not ours. */
export type MessageMetadata = Record<string, unknown>;

/** The read half of a mailbox. `GmailClient` satisfies this structurally; tests hand the sync an in-memory fake. */
export interface InboxReader {
  listMessages(
    sender: string,
    query: string,
    opts: { pageToken?: string | null; maxResults?: number; includeSpamTrash?: boolean },
  ): Promise<[string[], string | null]>;
  getMetadata(
    sender: string,
    messageId: string,
    headers: readonly string[],
  ): Promise<MessageMetadata>;
  getRaw(sender: string, messageId: string): Promise<Uint8Array>;
}
