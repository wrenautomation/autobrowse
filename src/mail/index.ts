/**
 * `@wrenautomation/autobrowse/mail`: read an inbox without a browser. A pure library: the readers
 * take a `fetch` or an IMAP login and return Gmail-shaped metadata, so one sync reads every kind
 * of inbox the same way.
 */
export { headerList, ImapReader, type ImapReaderOptions, RoutedReader } from "./imap.js";
export {
  type InstantlyEmail,
  InstantlyReader,
  type InstantlyReaderOptions,
  metadataOf,
  rawOf,
} from "./instantly.js";
export { imapClient, inFolder, type Login, specialFolder, withImap } from "./session.js";
export { type InboxReader, METADATA_HEADERS, type MessageMetadata } from "./types.js";
