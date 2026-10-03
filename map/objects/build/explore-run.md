---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-30 @ runs-and-walks
entity: src/runs/log.ts
---

# Explore run

One explore session's history, from `goal` to `done`, kept for good: `RunLog` in `src/runs/log.ts`, one hash-chained file `runs/<site>/<run>.jsonl` beside the credentials file. The CLI calls it `explored` (`runs` is the workflow registry).

## Why this shape

The journal is resume state and goes on `close`; history has to outlive it so walks can be built from many sessions and token spend can be read back. Per owner and outside git: acts carry typed values and URLs.

## Shape

- `RunRow`: `start` (driver, goal, machine, viewport), `goal`, `cmd` (answer chars and tokens, whole-page size), `act` (the journaled act, the look before it, `hand`), `end` (outcome, summary, last look) — `src/runs/log.ts:35-86`
- `RunOutcome`: achieved, failed, saved, closed, idle — `:33`; `RunSummary` (one line per ended life in `index.jsonl`) — `:93-107`
- `runLog(dir, site, {id})` writes rows synchronously and chains them (credvault `rowHash`) — `:163-244`; `readRun`, `listRuns`, `openRuns` (the last life died without `end`) — `:247-319`
- The explore server opens a run on the first command or a `goal`, ends it on `done`, `save`, `close` or idle — `openRun` `src/explore/server.ts:637`, `endRun` `:660`; the `goal`/`done` commands — `:191`
- Dir: `runsDirFor` — `src/app/services.ts:558`

## Connected to

- **owned-by:** [[explore-session]]
- **joins:** [[walk-spec]] (built from runs), [[llm-call]] (the token report reads both), [[agent-session]] (an agent run's driver is `agent:<model>`), [[screen]] (`PageLook`)
- **looks-like-but-is-not:** an engine run ([[run-object]], [[runs-registry]]); the explore journal; a [[recording]]

## If you change this

- **Hits:** `src/explore/server.ts` (writes it), `src/walks/build.ts` (reads acts and looks), `src/runs/tokens.ts` (reads `cmd` rows), `src/app/cli-runs.ts` (`explored`).
- **Does not hit:** recordings, compiled workflows, the registry.

## Surfaces

| Surface | Role |
|---|---|
| explore server | writes |
| `autobrowse explored`, `walks build`, `tokens` | read |

## See

- Source: `src/runs/log.ts`
- Design: `designs/2026-09-30-runs-and-walks.md`
