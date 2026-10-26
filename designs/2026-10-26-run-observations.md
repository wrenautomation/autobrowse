# Run observations (RL data from explore runs)

Task: WA-885. Status: building.

## Goal

Each explore run records each step in full. A step has three parts: what the model saw, what it did, and what came of it. A trainer then reads (state, action, outcome) rows. Today a run keeps only the acts, the misses and the outcome. It does not keep the state.

## Target state

- **Observation.** Each command row holds `obs`, the hash of the answer that the caller got. The run stores the masked copy, also when the caller asked for `raw`. A row after an act holds `after`, the hash of the whole aria tree. The `full` measure reads that tree already.
- **Pictures.** A JPEG at quality 80, at CSS size, kept by hash. The run takes one at: a new screen (the landmarks or the URL shape changed), each marks shot (the clean page, plus the box list), and the run end. Each miss takes marks, so each miss gets a picture.
- **Session link.** The `start` row holds the Claude Code session id. A `cmd` row holds `session` when the `x-claude-session` header names a different session.
- **Storage.** The texts go to `runs/<site>/<run>.obs.jsonl`, one line per hash and each hash once. At the run end the file becomes `.obs.jsonl.zst`. zstd's long window shares the text of near-equal trees, so no delta code is needed. The pictures go to `runs/blobs/<hash>.jpg`.
- **Ship and clear.** `shipShots` gets a `runs` root: the `.zst` files, the pictures and the run files. After the ledger shows a file in the bucket, the ship removes the `.zst` file and the picture from this disk. The run JSONL stays local, because walks and the token report read it.
- **No leaks.** The server masks each answer before it leaves, also a `raw` one: typed values and secret fields show `<redacted>`. The stored copy then goes through `redactText` again. The `after` tree is raw, so it gets `redactAria` and `redactText`. No step applies `redactPii`. Emails and phone numbers in page text go to the private bucket, as the shipped `aria.txt` files already do. A personal profile (`isPersonalProfile`) records no text and no pictures. The bucket is the private shots bucket.
- **Export.** `autobrowse runs steps` writes the autotrack steps shape. The old Playwright traces convert to the same shape.

## Cost

About 2 KB of zstd text and 60 to 150 KB of pictures per step. 1,000 steps a week is about 0.15 GB a week. S3 Standard costs about $0.02 a month for that. Glacier IR can come later through a lifecycle rule.

## Decision log

- 2026-10-26: William approved the plan. His terms: clear it locally, no leaks.
- 2026-10-26: Transcript bodies do not ship. Only the session id ships. A transcript can hold a pasted password, and a vault scrub cannot catch a value that was never in the vault. Bodies need a separate yes.
- 2026-10-26: One sidecar file per run, with zstd at the end. Hash blobs are used for the text only within one run. Cross-step deltas come from zstd, not custom code.
- 2026-10-26: No picture at the run start. The first page is usually blank, and an async start row would break the row order.
- 2026-10-26: `cleanupPeriodDays: 365` in the global Claude Code settings, so session links reach a transcript for a year. It is not 3650: transcripts grew 5.3 GB in 30 days, and the disk has 181 GB free.
- 2026-10-26: First real run (example.com, 6 commands): two pictures, 140 KB; the packed texts were 2.7 KB.
- 2026-10-26: Old runs and old traces stay. A converter gives them the steps shape after capture is live.
