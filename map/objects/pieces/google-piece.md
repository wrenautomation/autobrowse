---
type: object
cluster: pieces
universe: live
status: verified
verified: 2026-10-20 @ 2922634
entity: src/google/index.ts
---

# Google piece

The `./google` subpath: service-account auth with domain-wide delegation, the Gmail wire (`GmailClient`) and the per-user helper `gmailClient` built on it. A pure library; wren imports it and autobrowse uses it too.

## Why this shape

One copy of the auth and one copy of the Gmail wire, for both repos. Every call takes a `FetchLike`; the token exchange goes through the same one. The piece adds no time limit and no retry. autobrowse's `gmailFor` passes `fetchOf(http)` (`src/clients/http.ts:163`) so its calls keep the `HttpClient` timeout and retries. A non-2xx answer is a `GmailApiError`.

## Shape

- Auth: `SCOPES`, `delegatedScopes`, `loadServiceAccountKey(path, envName = "GOOGLE_SERVICE_ACCOUNT")`, `serviceAccountToken`, `postmasterToken`, `authedJson(http, …)` (the one function that takes an `HttpClient`) — `src/google/auth.ts:15,31,79,180,230,251`
- Wire: `GmailClient` (`sendRaw`, `findByMessageId`, `listMessages`, `getMetadata`, `getMessage`, `watch`, `searchAll`, `sendAs`, `patchSendAs`, `getRaw`), `GmailApiError`, `gmailPushTopic` — `src/google/gmail.ts:26,62,70`
- Helper: `gmailClient({ tokenFor, scopes, fetch? })` makes one `GmailClient` per scope; `GmailUserClient` (`setSignature`, `send`, `recent`, `search`, `whole`), `mimeMessage`, `rawHeader`, `messageText` — `src/google/gmail.ts:240,336,452,272,305`
- Composer: `gmailFor` — `src/app/services.ts:1352`
- Exports — `src/google/index.ts`; tests — `test/google-piece.test.ts`, `test/gmail.test.ts`

## Connected to

- **owns:** the Gmail wire and the service-account token
- **joins:** [[sign-in-context]] (Gmail is a code reader), [[mail-piece]], [[settings]] (`googleTokens`, `src/app/services.ts:1299`)
- **looks-like-but-is-not:** [[identity-provider]] (the browser sign-in to Google); a site's OAuth [[token]]

## If you change this

- **Hits:** every importer of `google/auth.js` and `google/gmail.js` (`src/app/services.ts`, `src/channels/email.ts`, `src/workflows/domain/deps.ts`, `src/chores/unsubscribe.ts`, `src/clients/google-admin.ts`, `src/auth/identities.ts`), wren's mailbox code (outside the tree), `scripts/build-check.mjs`
- **Does not hit:** the browser Google sign-in (`src/auth/google.ts`)

## Surfaces

| Surface | Role |
|---|---|
| wren `channel-email`, `core` | import the auth and the wire |
| autobrowse composers | `gmailFor`, `googleTokens` |

## See

- Source: `src/google/index.ts`
- Design: the wren repo doc designs/2026-10-20-autobrowse-pieces.md
