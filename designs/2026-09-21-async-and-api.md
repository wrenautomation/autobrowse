# Async audit and API shape (2026-09-21)

Trigger: a payment-gate reply took 12 minutes to land and the ask timed out
at 10; the heal waited on a session with no ceiling. William: "make sure
all code esp past ones are smart with threads and asynchronicity", then
"apis intuitive, minimize payloads, pagination if needed, reduce round
trips", "options first class, not inconvenient".

## Concurrency rules now in code

- Nothing blocks the event loop past a launch. `src/devices/phone.ts`
  reads chat.db and sends iMessages with `execFile` (30 s cap), never
  `execFileSync`. The remaining sync fs is small and per request.
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

1. `Jobs.wait` races a settled promise against a timer per call; many
   tabs waiting on one job hold many timers. Fine at one operator.
2. The Runs page merge re-sorts the whole list per event; fine under
   1k rows, the page size caps it anyway.
3. `listRecordings` still reads every manifest to make rows; a manifest
   index would save that once recordings number in the hundreds.
4. `inbound` (channel commands) reads the newest 100 runs to find the
   waiting one; a run older than that cannot be answered by text.
5. Step `clip` keeps 6 KB per string; a desktop tree cut mid-line is
   still readable, the model only ever saw 6 KB anyway.
