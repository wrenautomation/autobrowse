---
type: object
cluster: pieces
universe: live
status: verified
verified: 2026-10-20 @ 2922634
entity: src/mail/index.ts
---

# Mail piece

The `./mail` subpath: readers that turn an inbox (IMAP or Instantly) into one `InboxReader` shape, plus the IMAP session helpers. A pure library; wren imports it.

## Why this shape

wren reads replies in its own Lambda, so the Mac and its browser stay out of the path. A piece takes an IMAP `Login` or a `fetch`, and does no retries: the caller sets its time limit and retry policy. `test/pieces.test.ts` fails if any file it reaches imports Playwright, `src/browser`, `src/app` or `src/sites`.

## Shape

- `InboxReader`, `MessageMetadata`, `METADATA_HEADERS` — `src/mail/types.ts:11,28,31`
- `Login { host, port, user, pass }`, `imapClient`, `withImap`, `specialFolder`, `inFolder` — `src/mail/session.ts:8-64`
- `ImapReader(login, opts)`, `RoutedReader`, `headerList` — `src/mail/imap.ts:23,45,133`
- `InstantlyReader({ apiKey, fetch? })`, `metadataOf`, `rawOf` — `src/mail/instantly.ts:42,122,132`
- Exports — `src/mail/index.ts:6-15`; test — `test/mail.test.ts`
- Not here: sending (SMTP, `InstantlyTransport`) and the warmup admin `src/clients/instantly.ts`

## Connected to

- **owns:** the IMAP session helpers
- **joins:** [[google-piece]] (same rules), `test/pieces.test.ts` (the purity check)
- **looks-like-but-is-not:** the code readers of [[sign-in-context]] (`MessageReader`, `src/auth/codes.ts`), which read one-time codes

## If you change this

- **Hits:** wren's inbox sync (outside the tree), `scripts/build-check.mjs` (entry names), `package.json` `exports`
- **Does not hit:** [[sign-in-context]] code readers; `src/clients/instantly.ts`

## Surfaces

| Surface | Role |
|---|---|
| wren `channel-email` | imports the readers |
| autobrowse itself | none yet |

## See

- Source: `src/mail/index.ts`
- Design: the wren repo doc designs/2026-10-20-autobrowse-pieces.md
