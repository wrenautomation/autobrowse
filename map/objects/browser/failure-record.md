---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/session.ts
---

# Failure record

What a flow left behind when it stopped, as data: `FailureRecord` in `src/browser/session.ts`, written as `*.failure.json` under the artifacts dir.

## Why this shape

Heal, repair and the evaluator all start from the same file: site, flow, url, the goal and hints of the act that broke, how many acts came before, the kind (`failed | human | interrupted`), a screenshot and the aria tree.

## Shape

- `FailureRecord` — `src/browser/session.ts:51-68`
- Written by the runner into `ARTIFACTS_DIR` (default `~/.config/autobrowse/artifacts`, `src/app/services.ts:519`); `App.onFailure` hands each one to the healer — `src/app/services.ts:434`, `src/app/backend.ts:217`
- Read: `readFailures` — `src/agent/evaluator.ts:42`; `locateFailure` — `src/agent/heal.ts:72`

## Connected to

- **owned-by:** [[flow]] (the runner writes it)
- **joins:** [[compiled-workflow]] (heal), [[proposal]] (evidence), [[watch-step]] (`steps` when watched)
- **looks-like-but-is-not:** a [[run-event]] `finished` with status failed (the engine's view)

## If you change this

- **Hits:** `src/agent/heal.ts`, `src/agent/evaluator.ts`, `src/app/backend.ts:217`, UI `/api/artifacts` (`src/ui/api.ts:551`), `autobrowse repair`.
- **Does not hit:** the run object or registry.

## Surfaces

| Surface | Role |
|---|---|
| runner | writes |
| healer, evaluator, UI, CLI | read |

## See

- Source: `src/browser/session.ts:51`
