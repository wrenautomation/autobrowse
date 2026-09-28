---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/watch.ts
---

# Watched step

One line per act of a run named in `WATCH_FLOWS`, with a masked shot and aria beside it: `Step` in `src/browser/watch.ts`, `steps.jsonl` in the run's artifacts dir.

## Why this shape

A run that must be explained afterwards is watched at act granularity; every other run pays nothing.

## Shape

- `Step { n, at, kind: open|act|captcha|sign-in, goal, op?, hints?, url, ms, outcome, error?, shot?, aria? }` — `src/browser/watch.ts:28-47`
- `watches(spec, site, name)`; `watchSteps(dir)`; `watchedRuns` — `:62-165`

## Connected to

- **owned-by:** [[flow]] (the runner wraps each act)
- **joins:** [[failure-record]] (`steps`), [[hints]]
- **looks-like-but-is-not:** the agent's `StepRecord` ledger (`~/.config/autobrowse/steps.jsonl`, `src/agent/ledger.ts:10`)

## If you change this

- **Hits:** `src/browser/flow.ts`, `autobrowse watched` (`src/app/cli-watched.ts`).
- **Does not hit:** agent sessions, the engine.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse watched` | reads |

## See

- Source: `src/browser/watch.ts`
