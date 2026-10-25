# Trace backup and sweep (2026-10-24)

## Goal

Traces are William's "super important data". Keep every one for good, off this Mac. Free the disk after.

## Facts

- `~/.config/autobrowse/artifacts`: 1013 trace zips, 4.5 GB. `~/.local/share/internships/artifacts` (a `flowRunner` caller): 1179 zips, 13.6 GB.
- Internships wrote 8.5 GB on 10-23. Traces are written only on a failed flow (`flow.ts`); 895 failures that day.
- Screencast JPEG frames are ~90% of a zip. Exact frame dedup frees ~20%.
- Nothing deleted traces before. `shipShots` copies shots only, and only with `SHOTS_BUCKET`.

## Design

- `src/shots/traces.ts`: `backupTraces` copies each zip not yet kept, oldest first, streamed. Ledger `traces-kept.tsv` in the state folder: key, size, mtime.
- `sweepTraces` removes a zip older than `TRACES_KEEP_DAYS` (3; 14 until 10-25) only when the ledger has its exact line. A changed file is kept.
- A failure whose shape (site, flow, error with numbers and URLs taken out) kept a trace in the last day keeps no new trace (`firstTraceOfShape`, marks in `<artifacts>/.trace-shapes.json`). 10-25: a broken LinkedIn post-stats read failed 115 times a day at ~20 MB each.
- `TRACES_TO`: `s3://bucket[/prefix]` or a folder. Unset = no copy, no sweep. It does not need `SHOTS_BUCKET`.
- `TRACE_DIRS`: callers' artifact folders (comma list). Key: `traces/<machine>/<parent>-<dir>/<file>`.
- S3 store: Glacier Instant Retrieval, the bucket's SSE-S3 (AES256). Key under the owner's segment, so owner IAM fences hold.
- Desk: copy then sweep every `SHOTS_EVERY_MINUTES` (min 15), and one minute after start. CLI: `autobrowse traces push|sweep [--dry]`.

## Decision log

- 2026-10-24: target = the shots bucket (vault account, private, AES256), not R2 (same reason as 09-23: tokens). SSE-KMS not used: KMS costs per call (see aws-spend memory).
- 2026-10-24: restic (client-side key, AWS-blind) rejected for now: zips do not chunk-dedup, a new binary and key on each machine. Switch if William wants AWS unable to read traces.
- 2026-10-24: Glacier IR over Deep Archive: instant reads for a debug, ~$0.004/GB-month. Deep Archive is ~4x cheaper with a 12 h restore.
- 2026-10-24: no lossy compaction (frame drop, re-encode). Sweep after backup frees the disk; the backup keeps full fidelity.
- Closed (William, keep them): internships failure volume (~8.5 GB/day) grows the backup ~250 GB/month, ~$1/month more each month. Fewer frames per trace or fewer failures cut it.
- 2026-10-24: William: retry traces stay ("redundant traces are useful"). Lifecycle rule `traces-deep-archive`: `traces/` moves to Deep Archive after 90 days (Glacier IR's minimum). A year of traces ≈ $3/month, not $12. Older than 90 days = up to 12 h to restore.

