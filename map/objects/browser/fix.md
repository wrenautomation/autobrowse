---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/fixes.ts
---

# Fix

A repair that worked, kept so the next run tries it before the source's own hints: `Fix` in `src/browser/fixes.ts`, file `fixes.json`. A repair itself is a `Repairer` proposal (`src/browser/repair.ts`).

## Why this shape

The runner repairs one act at a time through a model (`llmRepairer`). Keeping what worked makes the second run deterministic and cheap; `applyFixes` or heal patches the source for good and the fix is dropped.

## Shape

- `Fix { flow, goal, failed, hints, detours?, reason, url, found, used }` — `src/browser/fixes.ts:15-31`; `Fixes` store `find/learn/used/flush/drop/list/forget` — `:33-50`; `FIXES_FILE` = `~/.config/autobrowse/fixes.json` (`src/app/config.ts:112`)
- `RepairRequest`, `RepairProposal { hints, reason, detour? }`, `Repairer`, `RepairReport` — `src/browser/repair.ts:19-50`; `rememberingRepairer(memory, next)` — `:190`
- Irreversible acts are never repaired unless `repairIrreversible` — `src/browser/flow.ts:235`
- Patch into source: `swapHints`, `replaceOp` — `src/compiler/patch.ts:63-90`; `applyFixes` — `src/agent/heal.ts:253`

## Connected to

- **owned-by:** the runner (`RunnerOptions.fixes`, `src/browser/flow.ts:239`)
- **joins:** [[hints]], [[flow]], [[compiled-workflow]] (patched), [[state-files]]
- **looks-like-but-is-not:** [[screen]] (a page a walk knows); heal (rewrites a step)

## If you change this

- **Hits:** `src/browser/flow.ts` (act path), `src/browser/repair.ts`, `src/agent/heal.ts:253`, `src/compiler/patch.ts`, `autobrowse repairs` (`src/app/cli-record.ts`).
- **Does not hit:** screens; the agent's own act loop (it does not use the repairer).

## Surfaces

| Surface | Role |
|---|---|
| runner | find, learn, used |
| `autobrowse repairs --apply` | patch source, drop |

## See

- Source: `src/browser/fixes.ts`, `src/browser/repair.ts`
