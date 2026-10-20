---
type: object
cluster: money
universe: live
status: verified
verified: 2026-10-20
entity: src/files/store.ts
---

# File

A file a form takes, in one sealed store: a `paper` (an ID document: a licence, a passport, a business registration) or a `doc` (a resume, a transcript, a work history). `FileRecord` and `FileStore` in `src/files/store.ts`. Kept like a [[card]], under the wallet's Keychain key. Named sets (`coop: resume, transcript`) let an explore session start with some at the ready.

## Why this shape

A file never passes through a log or a plaintext file: `upload{files:["file:<name>"]}` reads it inside the explore server and hands Playwright the bytes from memory (`filePayload`); a temp file would be read lazily by Chrome, so it could not be removed right after. A paper needs a person's yes once per file and host; a doc goes at once. Both are audited (`file:<name>`). A doc's text is read once at add time (`textOf`: unpdf, mammoth, text as is) and sealed in the index, so `read_file` answers without a parser; a paper's text is never kept. The type comes from the bytes (`sniffType`); a name only tells Markdown from text. The backup is an S3 bucket whose policy denies every principal but William's IAM user (`deploy/terraform/papers.tf`), so no machine role, Lambda, box or owner role reaches it. A phone sends one by a drop: wren's phone Worker page seals it in the browser under the link's fragment key; only this Mac opens it (`mintDrop`, `takeDrop`).

## Shape

- `FILE_KINDS`, `PAPER_IDS`, `FILE_TYPES`, `PAPER_TYPES`, `FILE_MAX_BYTES` (12 MB) — `src/files/store.ts:29-68`; `fileSchema` / `FileRecord { name, kind, id?, side?, note, owner?, type, bytes, sha256, text?, expires?, addedAt }` — `:72-106`
- `sniffType`, `fileOf`, `describeFile`, `fileLine` — `src/files/store.ts:112-205`; `textOf` — `src/files/text.ts:11`
- `FileStore` (list, get, put, remove, sets, setSet), `memoryFiles`, `fileStore` (`~/.config/autobrowse/files/`, `src/app/config.ts:230`) — `src/files/store.ts:207-319`
- `FileBucket`, `bucketFiles` (prefix `files/`, sets in `files.sets`, record in metadata less the text), `backedUpFiles` — `src/files/store.ts:321-446`; `s3FileBucket` — `src/shots/s3.ts:31`
- `fileRef`, `filePayload`, `filesInSets` — `src/files/store.ts:449-488`
- `migratePapers`, `retiredDirFor` (old `papers/` → copy, read back, then `papers-retired`) — `src/files/migrate.ts:44-114`
- `filesFor`, `oldPapersDir`, `filesForExplore` — `src/app/services.ts:1008-1044`
- explore `files`, `fileSets`, `filesYes`, `uploadFiles`, the `files` and `read_file` commands — `src/explore/server.ts:511`, `:1151`, `:1168`, `:1687`; the act's `FilePayload` — `src/browser/flow.ts`
- drops: `mintDrop`, `takeDrop` — `src/auth/link.ts:108-144`; CLI `src/app/cli-files.ts`; `explore --files` — `src/app/cli-record.ts:65`
- library export `autobrowse/files` — `src/files/index.ts`

## Connected to

- **owned-by:** the files store
- **joins:** [[approval]] (an upload of a paper is a gated act), [[explore-session]] (`files`, `--files`), [[card]] (same Keychain key, same Mac-only rule)
- **looks-like-but-is-not:** [[credential]]; a screenshot (shots bucket)

## If you change this

- **Hits:** `src/explore/server.ts` (`uploadFiles`, `files`, `read_file`), `src/browser/flow.ts` (`uploadFiles`, `Op`), `src/app/services.ts`, `src/app/cli-files.ts`, `src/app/cli-record.ts`, `deploy/terraform/papers.tf`, wren `apps/phone` (`/drops`, `/u/<id>`, `public/u.js`: its accept list is images and PDF only).
- **Does not hit:** the wallet's cards; the credential vault.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse files add`, `ask`, `set`, `unset`, `remove`, `migrate`, `restore` | write |
| `autobrowse files list`, `sets` | read, never the bytes or text |
| wren phone Worker `/u/<id>` | a phone sends one, sealed |
| explore `upload`, `files`, `read_file` | uploads one, lists them, a doc's text |

## See

- Source: `src/files/`; design `designs/2026-10-20-files.md` (was `designs/2026-10-12-papers.md`)
