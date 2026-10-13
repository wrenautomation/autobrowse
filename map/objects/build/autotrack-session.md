---
type: object
cluster: build
universe: live
status: verified
verified: 2026-10-13 @ d840ab3
entity: src/autotrack/types.ts
---

# Autotrack session

What `autotrack` (the recorder in the autotrack repo, on William's and his sister's laptops) writes and ships: every input and screen, in segments, under one device's prefix in the track bucket. autobrowse reads it back, labels it offline (why each act, what came of it), and turns one into a [[recording]] of desktop acts.

## Why this shape

The recorder is its own package and imports nothing from `src/`; this side copies the session format (`src/autotrack/types.ts`, from `autotrack repo designs/2026-10-13-autotrack.md`; kept in step with `autotrack src/events.ts` by hand). Each device gets an IAM user that can only `s3:PutObject` under `<device>/*`, so a lost laptop leaks nothing; its key travels inside the install code, which is therefore a credential by design. Import keeps only what a desktop op can replay (clicks with an element, text, keys) and leaves the rest as notes or out.

The labelling pass is separate and pure up to the model call: events become acts (OS click joined to its web click), acts get rule signals, acts group into episodes, and only then does a model write a goal, an outcome and an intent per act. Rules rerun over old data for free; the model's answers are cached by a hash of what was sent. A person's `task` goal beats the model's. Nothing redacted, and no frame from a paused period, is ever sent.

## Shape

- Bucket `<prefix>-track-<account>`, Glacier IR after 30 days — `deploy/terraform/track.tf`; `TRACK_BUCKET` — `src/app/config.ts:234`
- Key layout `<device>/<session>/session.json`, `…/<segment>/events.jsonl.gz`, `…/<segment>/frames/<n>.jpg` — `parseKey`, `listSessions`, `s3TrackStore` — `src/autotrack/store.ts:25`, `:78`, `:92`. Also `labels/<device>/<session>.json` (labels; `labels` is a reserved device name, `RESERVED_DEVICES`, `src/autotrack/code.ts:14`); only William's user writes it (`TrackWriter.put`)
- `Event`, `SessionMeta` — `src/autotrack/types.ts:89`, `:198`; `Labels`, `ActSignals`, `EpisodeOutcome` (autobrowse's own) — `src/autotrack/types.ts:219-234`
- Install code `{ v:1, bucket, region, device, keyId, secret }`, base64url JSON — `encodeCode`, `decodeCode`, `installCommands` — `src/autotrack/code.ts:31-54`; `autotrack src/config.ts` must accept the same
- `enroll`, `revoke`, `devices`, `putOnlyPolicy` over the `Iam` seam — `src/autotrack/enroll.ts:39-72`; real client `src/autotrack/iam.ts`
- `eventsToActions`, `readSession`, `readLabels`, `importSession` (events + referenced frames into `<recordings>/<name>/track/`; each action carries its `intent` when labels exist) — `src/autotrack/import.ts:47`, `:138`, `:173`, `:190`
- `buildActs` (events to acts; `joinClicks` pairs an OS click with a web click when `|Δts| < 150 ms` and ≤ 4 px, the web target replaces a thin OS element, effects fold into their cause) — `src/autotrack/join.ts:129`, `:195`
- `signalsFor` (dwell, hover, dead, rage, correction, error; each a pure rule, `dead` needs evidence) — `src/autotrack/signals.ts:214`
- `splitEpisodes` (`task` markers, else idle ≥ 2 min or an unrelated app/domain held ≥ 30 s) — `src/autotrack/episodes.ts:87`
- `labelSession` (model per episode: goal, outcome, confidence, intent per act; zod-checked; frames shrunk to 768 px; batched; cached on disk by hash; pause assert) — `src/autotrack/label.ts:474`; `labelOne`, `unlabelled` (read, label, write to the bucket and beside the import) — `src/autotrack/label-run.ts:35`, `:68`
- CLI `track enroll|devices|list|import|label` — `src/app/cli-autotrack.ts`; the model is the gateway's `gemini/gemini-3.1-flash-lite` (`labelLlm`, `LABEL_MODEL`, `src/app/cli-autotrack.ts:37`, `:43`)

## Connected to

- **owned-by:** the track bucket
- **joins:** [[recording]] (`Action` kind `desktop`, `saveRecording`), [[settings]] (`trackBucket`), [[outline]] (`structure` reads the desktop acts)
- **looks-like-but-is-not:** a screenshot in the shots bucket; an explore run's journal

## If you change this

- **Hits:** `autotrack src/events.ts`, `autotrack src/config.ts`, `autotrack src/ship.ts` and the installers (the format, the code, the key layout), `deploy/terraform/track.tf`, the IAM users under `/track/`, `test/autotrack.test.ts`, `test/autotrack-signals.test.ts`, `test/autotrack-label.test.ts`. A new event kind or field the labeller reads (`join.ts`, `signals.ts`, `label.ts` prompt) needs `PROMPT_VERSION` bumped or old cache entries stay.
- **Does not hit:** the shots bucket; the papers bucket.

## Surfaces

| Surface | Role |
|---|---|
| `autotrack ship` | writes (put only) |
| `autobrowse autotrack enroll` | mints and revokes the write key |
| `autobrowse autotrack list`, `import` | read (William's AWS user) |
| `autobrowse autotrack label <device>/<session> [--no-model]`, `label --all [--device d]` | reads, then writes `labels/<device>/<session>.json` and `<recordings>/<name>/track/labels.json` (`--all`: sessions with no labels yet) |

## See

- Source: `src/autotrack/`; design `autotrack repo designs/2026-10-13-autotrack.md`
