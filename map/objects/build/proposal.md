---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/agent/evaluator.ts
---

# Proposal

A workflow worth building, argued from failures, sessions and recordings: `Proposal` from `proposeWorkflows` in `src/agent/evaluator.ts`; built by `src/agent/builder.ts`.

## Why this shape

Evidence, not aspiration: a proposal carries `occurrences` and `covered`, so what already has a recording or a workflow is kept for the record and never built twice.

## Shape

- `Proposal { title, why, site, goal, occurrences, covered }` — `src/agent/evaluator.ts:15-27`; `Evidence { failures, sessions, recordings, workflows? }` — `:30-40`; `readFailures` — `:42`; `proposeWorkflows` — `:88`
- `pickBuildable`, `settleSession`, `buildProposals` (agent explores → save → compile) — `src/agent/builder.ts:53-121`; `recordingNameFor(title)` — `:41`

## Connected to

- **owned-by:** none (computed on request)
- **joins:** [[failure-record]], [[agent-session]], [[recording]], [[compiled-workflow]]

## If you change this

- **Hits:** `src/agent/builder.ts`, UI `/api/agent/proposals` (`src/ui/api.ts:565`), `src/app/cli-do.ts` (if it lists proposals).
- **Does not hit:** heal (works from one failure, not the set).

## Surfaces

| Surface | Role |
|---|---|
| UI, CLI | read, build |

## See

- Source: `src/agent/evaluator.ts`, `src/agent/builder.ts`
