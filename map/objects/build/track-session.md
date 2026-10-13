---
type: object
cluster: build
universe: live
status: verified
verified: 2026-10-13 @ 4e60b74
entity: src/track/types.ts
---

# Track session

What `wren-track` (the recorder in `track/`, on William's and his sister's laptops) writes and ships: every input and screen, in segments, under one device's prefix in the track bucket. autobrowse reads it back and turns one into a [[recording]] of desktop acts.

## Why this shape

The recorder is its own package and imports nothing from `src/`; this side copies the session format (`src/track/types.ts`, from `designs/2026-10-13-track.md`; a test checks it equals `track/src/events.ts`). Each device gets an IAM user that can only `s3:PutObject` under `<device>/*`, so a lost laptop leaks nothing; its key travels inside the install code, which is therefore a credential by design. Import keeps only what a desktop op can replay (clicks with an element, text, keys) and leaves the rest as notes or out.

## Shape

- Bucket `<prefix>-track-<account>`, Glacier IR after 30 days — `deploy/terraform/track.tf`; `TRACK_BUCKET` — `src/app/config.ts:234`
- Key layout `<device>/<session>/session.json`, `…/<segment>/events.jsonl.gz`, `…/<segment>/frames/<n>.jpg` — `parseKey`, `listSessions`, `s3TrackStore` — `src/track/store.ts:62-76`
- `Event`, `SessionMeta` — `src/track/types.ts:30`, `:97`
- Install code `{ v:1, bucket, region, device, keyId, secret }`, base64url JSON — `encodeCode`, `decodeCode`, `installCommands` — `src/track/code.ts:31-54`; `track/src/config.ts` must accept the same
- `enroll`, `revoke`, `devices`, `putOnlyPolicy` over the `Iam` seam — `src/track/enroll.ts:39-72`; real client `src/track/iam.ts`
- `eventsToActions`, `importSession` (events + referenced frames into `<recordings>/<name>/track/`) — `src/track/import.ts:46`, `:118`
- CLI `track enroll|devices|list|import` — `src/app/cli-track.ts`

## Connected to

- **owned-by:** the track bucket
- **joins:** [[recording]] (`Action` kind `desktop`, `saveRecording`), [[settings]] (`trackBucket`), [[outline]] (`structure` reads the desktop acts)
- **looks-like-but-is-not:** a screenshot in the shots bucket; an explore run's journal

## If you change this

- **Hits:** `track/src/events.ts`, `track/src/config.ts`, `track/src/ship.ts` and the installers (the format, the code, the key layout), `deploy/terraform/track.tf`, the IAM users under `/track/`, `test/track.test.ts`.
- **Does not hit:** the shots bucket; the papers bucket.

## Surfaces

| Surface | Role |
|---|---|
| `wren-track ship` | writes (put only) |
| `autobrowse track enroll` | mints and revokes the write key |
| `autobrowse track list`, `import` | read (William's AWS user) |

## See

- Source: `src/track/`; design `designs/2026-10-13-track.md`
