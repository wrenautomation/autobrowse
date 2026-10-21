---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-10-20 @ HEAD
entity: src/browser/resume.ts
---

# Resume record

Where a durable call stopped: `ResumeRecord { url, profile, screensDone, at }` in `src/browser/resume.ts`, one file per `withCall` key, so the call's next try opens that page and its walks go on from there.

## Why this shape

A flow function cannot start at its line N, but a walk finds its screen by looking at the page. So the runner keeps the page, not the line. No input values or page text; the URL keeps origin and path, plus only the query keys the run's first URL carried (a minted token never lands on disk).

## Shape

- `ResumeRecord`, `Resumes` — `src/browser/resume.ts:14-29`; `fileResumes` (0600 files, 7-day age-out) — `:31`; `memoryResumes` — `:52`; `keptUrl` — `:68`; `sameHost` — `:85`
- File per call: `callFile`, `writeCallFile` (shared with `fileDoneActs`) — `src/browser/attempt.ts:91-111`
- Default dir: `resumeDir` — `src/deps/stats.ts:27` (`<state>/resume`, `AUTOBROWSE_RESUME=off`); `RunnerOptions.resume` (`false` = off) — `src/browser/flow.ts:341`
- Runner: read at `src/browser/flow.ts:568` (same profile only); first open redirected at `:922`; kept or dropped at `:982`; cleared on success at `:994`
- Walks: `Trail` — `src/browser/screens.ts:128`

## Connected to

- **owned-by:** [[flow]] (the runner)
- **joins:** [[screen]] (walks read and fill `screensDone`), [[flow-run]]
- **looks-like-but-is-not:** `DoneActs` (`src/browser/attempt.ts`: irreversible acts a call did, never cleared on success); [[failure-record]] (one broken run, for a person or the healer)

## If you change this

- **Hits:** `src/browser/flow.ts`, `src/browser/screens.ts` (`walk`), library callers that pass `resume`.
- **Does not hit:** runs with no call key; `DoneActs`.

## Surfaces

| Surface | Role |
|---|---|
| runner | reads, writes, clears |
| library (`withCall`, `fileResumes`, `resumeDir` from the package root) | key a run, move or turn off the store |

## See

- Design: `designs/2026-10-20-batched-plans-and-resume.md` §2
