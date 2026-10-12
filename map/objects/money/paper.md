---
type: object
cluster: money
universe: live
status: verified
verified: 2026-10-12
entity: src/money/papers.ts
---

# Paper

An identity document for a verification form (a driver's licence, a passport, a business registration), uploaded by name after one yes per paper and host: `Paper` and `Papers` in `src/money/papers.ts`. Kept like a [[card]], under the wallet's Keychain key.

## Why this shape

A paper never passes through a model, a log or a plaintext file: `upload{files:["paper:<name>"]}` reads it inside the explore server and hands Playwright the bytes from memory (`paperPayload`); a temp file would be read lazily by Chrome, so it could not be removed right after. The model sees kind, side, type and size only (`describePaper`). The type comes from the bytes (`sniffType`), never a name. The backup is an S3 bucket whose policy denies every principal but William's IAM user (`deploy/terraform/papers.tf`), so no machine role, Lambda, box or owner role reaches it. A phone sends one by a drop: wren's phone Worker page seals it in the browser under the link's fragment key; only this Mac opens it (`mintDrop`, `takeDrop`).

## Shape

- `Paper { name, kind, side, owner?, type, bytes, sha256, expires?, addedAt }` — `src/money/papers.ts:49-65`; `sniffType`, `paperOf`, `describePaper` — `:68-109`
- `Papers`, `memoryPapers`, `filePapers` (`~/.config/autobrowse/papers/`, `src/app/config.ts:230`), `PaperBucket`, `bucketPapers`, `backedUpPapers` — `src/money/papers.ts:111-262`; `paperRef`, `paperPayload` — `:264-283`
- `papersFor`, `papersForUpload` — `src/app/services.ts:967-993`; `s3PaperBucket` — `src/shots/s3.ts:31`
- explore `papers`, `papersYes`, `uploadFiles` — `src/explore/server.ts:468`, `:1090`; the act's `FilePayload` — `src/browser/flow.ts`
- drops: `mintDrop`, `takeDrop` — `src/auth/link.ts:107-144`; CLI `src/app/cli-papers.ts`

## Connected to

- **owned-by:** the papers store
- **joins:** [[approval]] (an upload of a paper is a gated act), [[explore-session]] (`papers`), [[card]] (same Keychain key, same Mac-only rule)
- **looks-like-but-is-not:** [[credential]]; a screenshot (shots bucket)

## If you change this

- **Hits:** `src/explore/server.ts` (`uploadFiles`), `src/browser/flow.ts` (`uploadFiles`, `Op`), `src/app/services.ts`, `src/app/cli-papers.ts`, `deploy/terraform/papers.tf`, wren `apps/phone` (`/drops`, `/u/<id>`, `public/u.js`).
- **Does not hit:** the wallet's cards; the credential vault.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse papers add`, `ask` | write |
| wren phone Worker `/u/<id>` | a phone sends one, sealed |
| explore `upload` | uploads one, never prints it |

## See

- Source: `src/money/papers.ts`; design `designs/2026-10-12-papers.md`
