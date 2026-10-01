---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/engine/events.ts
---

# Run event

What a run tells the world, one record per change: `RunEvent` in `src/engine/events.ts`; a `RunRow` is the fold of them.

## Why this shape

One stream feeds people (channels), the UI (bus) and the registry; rows are derived, never written by hand.

## Shape

- `RunRef { workflow, key }`; `runId` = `workflow/key` — `src/engine/events.ts:8-11,34`
- Types: `started`, `step`, `gate-opened`, `gate-answered`, `paused`, `resumed`, `finished`, `reset` — `:13-30`
- `RunRow` and `applyRunEvent(row, event)` — `src/engine/rows.ts:9-64`

## Connected to

- **owns:** nothing
- **owned-by:** [[run-object]] (emits through `HostDeps.emit`)
- **joins:** [[channel]] (`deliver`; `forwardChannel` posts them unchanged to a caller's feed, numbered by `seq`), [[runs-registry]] (`record`), the UI bus (`src/ui/bus.ts`), [[gate]]

## If you change this

- **Hits:** `src/engine/rows.ts`, `src/engine/registry.ts`, every `src/channels/*.ts` renderer (`src/channels/render.ts`), `src/ui/bus.ts`, `src/ui/api.ts:486` (`/api/events`), `src/app/idle.ts` (touched by every event).
- **Does not hit:** step results inside the run object, agent session steps.

## Surfaces

| Surface | Role |
|---|---|
| channels, UI SSE | read |
| run object | write |

## See

- Source: `src/engine/events.ts`, `src/engine/rows.ts`
