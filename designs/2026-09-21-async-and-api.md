# Async audit and API shape (2026-09-21)

Trigger: a payment-gate reply took 12 minutes to land and the ask timed out
at 10; the heal waited on a session with no ceiling. William: "make sure
all code esp past ones are smart with threads and asynchronicity", then
"apis intuitive, minimize payloads, pagination if needed, reduce round
trips", "options first class, not inconvenient".

## Concurrency rules now in code

- Nothing blocks the event loop past a launch. `src/devices/phone.ts`
  reads chat.db, sends iMessages and probes access with `execFile` (30 s
  cap), never `spawnSync`. Anything read per request or per step is
  `fs/promises`: the compiled catalog (readdir + stat + proof per
  workflow), failure records (read in parallel), heal's outline scan,
  proof write, session views (one coalescing writer per session: a burst
  of steps lands as the newest view once). What stays sync is one-shot
  and tiny: boot reads, the budget ledger and credential file (atomic
  rename), `.env` sink, failure artifacts, CLI commands.
- One driver per page. The explore server runs commands through one
  promise chain (`src/explore/server.ts`); pause, resume, journal, url,
  pages and close skip the queue so a person can always stop the machine.
- Every wait has a ceiling. Heal and the builder settle a session within
  30 min (`SETTLE_MS`); the payment ask waits 30 min by default; the
  evaluator never overlaps itself (`running` guard in `schedule.ts`).
- Minutes-long API work is a job (`src/ui/jobs.ts`): prove and heal
  return 202 with the job, one per kind+key (a second click joins), kept
  100 finished, `wait=<ms>` on `GET /api/jobs/:id` holds until settled.
  Status and finish time land in one assignment so a trim between the two
  cannot drop a just-finished job (the bug the first test caught).

## API shape

- Lists are rows: `/api/recordings` → `RecordingSummary` (counts),
  `/api/agent` → `SessionSummary` (`stepCount`), `/api/runs` → `RunRow`.
  Details carry the body. Agent step results are clipped to 6 KB per
  string at the source (`clip` in `explorer.ts`), which also bounds the
  session file rewritten on every step.
- `/api/runs?limit=&before=`: newest first, 100 a page, `before` is the
  last row's `updatedAt`. `pageOf` is the one implementation (registry
  handler, test fake, CLI `runs --limit --before`).
- The Runs page folds live events with `applyRunEvent` (`src/engine/
  rows.ts`, no runtime deps, shared with the UI) instead of refetching the
  list per event; the Run page refetches only on its own run's events.
- Client conveniences: `api.prove`/`api.heal` start the job and wait;
  `api.runs({ before })`; `api.job(id, wait)`.

## Where to attack (ranked)

1. ✅ (2026-09-22, by reading) `Jobs.wait` races a settled promise against
   a timer per call and clears the timer as soon as either wins; a waiter
   holds one timer for at most its own `ms`. Nothing to change.
2. ✅ (2026-09-22) An event's row lands in place (`placeRow`, one pass over
   a list already in order); a full `merge` + sort is only for a loaded page.
3. ✅ (2026-09-22) `summary.json` beside each manifest; `listRecordingSummaries`
   reads those (and writes one for an older recording on first sight). Lists
   and the evaluator use it; `listRecordings` stays for whole loads.
4. ✅ (2026-09-20) `inbound` pages back through the registry (`findRow`, up
   to 10 pages) for the named or the waiting run.
5. ✅ (2026-09-21) `before` is `cursorOf(row)` = `<updatedAt>~<workflow/key>`;
   rows order by (updatedAt, id) so a page edge hides nothing. A bare
   `updatedAt` still pages.
6. Step `clip` keeps 6 KB per string; a desktop tree cut mid-line is
   still readable, the model only ever saw 6 KB anyway.
