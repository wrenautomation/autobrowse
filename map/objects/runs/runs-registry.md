---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/engine/registry.ts
---

# Runs registry

The one Restate object (`Runs`, key `all`) that lists every run as rows, newest first: `runsRegistry` in `src/engine/registry.ts`.

## Why this shape

Restate has no cross-object query. A registry fed by events answers "what runs exist" without opening each run object.

## Shape

- Handlers: `record(event)`, `list(query)` (shared), `forget(id)` — `src/engine/registry.ts:49-68`
- One per [[owner]]: `Runs` for the default, `Runs_<owner>` for any other (`registryOf`, `:42`)
- Kept: `KEEP_ROWS` 2000, pages of `LIST_LIMIT` 100 with a cursor — `src/engine/rows.ts:66-95`
- A pre-2026-09-22 map is read once and written back as a list — `src/engine/registry.ts:24-26`

## Connected to

- **owned-by:** [[app]] (`App.services`)
- **joins:** [[run-event]], [[run-object]]
- **looks-like-but-is-not:** the step ledger (`~/.config/autobrowse/steps.jsonl`, agent steps), the UI job list (`src/ui/jobs.ts`)

## If you change this

- **Hits:** `src/engine/rows.ts`, CLI `runs` (`src/app/cli.ts:390`), UI `/api/runs` (`src/ui/api.ts:437`), `src/app/client.ts`.
- **Does not hit:** run state; channels.

## Surfaces

| Surface | Role |
|---|---|
| CLI, UI | read |
| run objects | write |

## See

- Source: `src/engine/registry.ts`
