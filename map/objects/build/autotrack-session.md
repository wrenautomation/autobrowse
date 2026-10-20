---
type: object
cluster: build
universe: live
status: verified
verified: 2026-10-14 @ cc14456
entity: src/autotrack/types.ts
---

# Autotrack session

What `autotrack` (the recorder in the autotrack repo, on William's and his sister's laptops) writes and ships: every input and screen, in segments, under one device's prefix in the track bucket. autobrowse reads it back, labels it offline (why each act, what came of it), derives the RL view (one step per act, with a quality score), and turns one into a [[recording]] of desktop acts.

## Why this shape

The recorder is its own package and imports nothing from `src/`; this side copies the session format (`src/autotrack/types.ts`, from `autotrack repo designs/2026-10-13-autotrack.md`; kept in step with `autotrack src/events.ts` by hand). Each device gets an IAM user that can only `s3:PutObject` under `<device>/*`, so a lost laptop leaks nothing; its key travels inside the install code, which is therefore a credential by design. Import keeps only what a desktop op can replay (clicks with an element, text, keys) and leaves the rest as notes or out.

The labelling pass is separate and pure up to the model call: events become acts (OS click joined to its web click), acts get rule signals, acts group into episodes, and only then does a model write a goal, an outcome and an intent per act. Rules rerun over old data for free; the model's answers are cached by a hash of what was sent. A person's `task` goal beats the model's. Nothing redacted, and no frame from a paused period, is ever sent.

The RL view (`steps`) is a second pure pass over the same acts. It points at files by number (frame, crop, tree, OCR) and never inlines pixels or text, so a trainer picks what it reads. Only the tree diff is computed: role + name, with a rename being the same role at the same id (else the same rect) under a new name. Coordinates go into frame pixels (`displays[].scale`, capped so the long side is 1920) on the display the event names. Quality is a share per episode and per session, over OS acts only (a web-only act has no frames): before and settled-after frames shipped, an element, a tree, a crop for pointer acts; `score` is the mean of the shares that apply. `--min-quality` drops episodes from the steps file at write time; the report keeps them.

## Shape

- Bucket `<prefix>-track-<account>`, Glacier IR after 30 days — `deploy/terraform/track.tf`; `TRACK_BUCKET` — `src/app/config.ts:234`
- Key layout `<device>/<session>/session.json`, `…/<segment>/events.jsonl.gz`, `…/frames/<n>.jpg`, `…/trees/<n>.json.gz|.txt.gz`, `…/crops/<n>.jpg` (raw), `…/ocr/<n>.json.gz` and `ocr/c<n>.json.gz` (a crop's), `…/stats.json.gz` — `parseKey`, `listSessions`, `s3TrackStore` — `src/autotrack/store.ts:107`, `:146`, `:32`. Also `labels/<device>/<session>.json` (labels), `steps/<device>/<session>.jsonl.gz` and `….quality.json` (RL view and its score); `labels` and `steps` are reserved device names (`RESERVED_DEVICES`, `src/autotrack/code.ts:17`); only William's user writes them (`TrackWriter.put`)
- `Event` (with `level`, `shot` and the act fields `settle`, `settled`, `path`, `crop`), `SessionMeta`, `Stats` (equal to `autotrack src/events.ts`) — `src/autotrack/types.ts:105`, `:224`, `:252`; `OcrFile`, `Labels`, `ActSignals`, `EpisodeOutcome` (autobrowse's own) — `src/autotrack/types.ts:284`, `:301`, `:289`, `:286`
- Install code `{ v:1, bucket, region, device, keyId, secret }`, base64url JSON — `encodeCode`, `decodeCode`, `installCommands` — `src/autotrack/code.ts:31-54`; `autotrack src/config.ts` must accept the same
- `enroll`, `revoke`, `devices`, `putOnlyPolicy` over the `Iam` seam — `src/autotrack/enroll.ts:39-72`; real client `src/autotrack/iam.ts`
- `eventsToActions`, `readSession`, `readStats`, `readLabels`, `importSession` (events, referenced frames, all trees, crops, OCR and stats into `<recordings>/<name>/track/`, through a pool of 8; each action carries its `intent` when labels exist) — `src/autotrack/import.ts:51`, `:158`, `:216`, `:234`, `:251`
- `buildActs` (events to acts; `joinClicks` pairs an OS click with a web click when `|Δts| < 150 ms` and ≤ 4 px, the web target replaces a thin OS element, effects fold into their cause) — `src/autotrack/join.ts:129`, `:195`
- `signalsFor` (dwell, hover, dead, rage, correction, error; each a pure rule, `dead` needs evidence) — `src/autotrack/signals.ts:214`
- `splitEpisodes` (`task` markers, else idle ≥ 2 min or an unrelated app/domain held ≥ 30 s) — `src/autotrack/episodes.ts:87`
- `labelSession` (model per episode: goal, outcome, confidence, intent per act; zod-checked; frames shrunk to 768 px; batched; cached on disk by hash; pause assert) — `src/autotrack/label.ts:474`; `labelOne`, `unlabelled` (read, label, write to the bucket and beside the import) — `src/autotrack/label-run.ts:35`, `:68`
- `buildSteps` (acts to one `Step` each: `obs`, `action` in frame pixels with `nx, ny`, `next`, `treeDiff`, `signals`, `intent`, `level`; trees loaded 24 acts at a time; typed text through the redaction gate) — `src/autotrack/steps.ts:349`; `frameScale`, `displayOf`, `toFrame` — `:47`, `:54`, `:83`
- `parseTree` (the recorder's node list, a nested tree, or a `.txt` outline), `diffTrees` (lists capped at 40, `counts` full) — `src/autotrack/tree.ts:62`, `:123`
- `contextOf`, `qualityOf` (level timeline, pauses, helper restarts from `Stats.restarts`; shares rounded to 3 places) — `src/autotrack/quality.ts:101`, `:111`
- `stepsOne` (writes `steps/…jsonl.gz`, then `….quality.json`, then the same beside the import), `readQualities` (what `list` shows), `qualityLine` — `src/autotrack/steps-run.ts:37`, `:81`, `:103`
- Heartbeat `<device>/heartbeat.json` (two parts, so `parseKey` skips it): `parseHeartbeat` (zod; only `v`, `version`, `at` required; bad JSON = `bad` with a reason), `readHeartbeat` (NoSuchKey = `none`), `problems` (paused, ship error, update error, backlog ≥ 10 segments or 1 GB), `deviceLine` — `src/autotrack/heartbeat.ts:45`, `:60`, `:85`, `:101`
- Fleet health: `healthTransitions` (silent = last beat over 24 h old, or none and enrolled over 24 h ago; an unreadable beat keeps the last state), `checkHealth` (posts each transition; a failed post keeps the old state so the next hour retries) — `src/autotrack/health.ts:43`, `:100`; the desk runs it 1 min after start, then hourly, default owner only, posting to `WREN_DISCORD_WEBHOOK_URL` (no pings) and keeping `<state>/autotrack-health.json` — `src/app/main.ts:181`
- CLI `track enroll|devices|list|import|label|steps` — `src/app/cli-autotrack.ts`; the model is the gateway's `gemini/gemini-3.1-flash-lite` (`labelLlm`, `LABEL_MODEL`, `src/app/cli-autotrack.ts:37`, `:43`)

## Connected to

- **owned-by:** the track bucket
- **joins:** [[recording]] (`Action` kind `desktop`, `saveRecording`), [[settings]] (`trackBucket`), [[outline]] (`structure` reads the desktop acts)
- **looks-like-but-is-not:** a screenshot in the shots bucket; an explore run's journal

## If you change this

- **Hits:** the recorder's heartbeat writer (the body), `autotrack src/events.ts`, `autotrack src/config.ts`, `autotrack src/ship.ts` and the installers (the format, the code, the key layout), `deploy/terraform/track.tf`, the IAM users under `/track/`, `test/autotrack.test.ts`, `test/autotrack-signals.test.ts`, `test/autotrack-label.test.ts`, `test/autotrack-steps.test.ts`, `test/autotrack-heartbeat.test.ts`, `test/autotrack-fixture.ts` and `test/fixtures/track/`. `Stats` and the quality fields are read here by name: a renamed counter in `autotrack src/stats.ts` reads as zero, not as an error. A new event kind or field the labeller reads (`join.ts`, `signals.ts`, `label.ts` prompt) needs `PROMPT_VERSION` bumped or old cache entries stay.
- **Does not hit:** the shots bucket; the files bucket.

## Surfaces

| Surface | Role |
|---|---|
| `autotrack ship` | writes (put only) |
| `autobrowse autotrack enroll` | mints and revokes the write key |
| `autobrowse autotrack devices` | IAM users plus each heartbeat: version, last seen, problems |
| the desk (`src/app/main.ts`) | reads heartbeats hourly; posts silent / back to the ops Discord lane |
| `autobrowse autotrack list`, `import` | read (William's AWS user); `list` also shows the quality `steps` stored |
| `autobrowse autotrack label <device>/<session> [--no-model]`, `label --all [--device d]` | reads, then writes `labels/<device>/<session>.json` and `<recordings>/<name>/track/labels.json` (`--all`: sessions with no labels yet) |
| `autobrowse autotrack steps <device>/<session> [--min-quality n]` | reads, then writes `steps/<device>/<session>.jsonl.gz`, `steps/<device>/<session>.quality.json` and both beside the import |

## See

- Source: `src/autotrack/`; design `autotrack repo designs/2026-10-13-autotrack.md`
