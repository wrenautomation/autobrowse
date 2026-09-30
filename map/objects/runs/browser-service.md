---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/engine/browser-service.ts
---

# Browser service

The Restate service `browser` that runs one hand-written flow as a durable step: `browserService` in `src/engine/browser-service.ts`.

## Why this shape

A flow under `ctx.run` retries when the browser dies, but `NeedsHuman` and `FlowFailed` become terminal errors with codes 460 and 461 so the original meaning survives the journal (`src/engine/browser-service.ts:48-49,124-144`).

## Shape

- `BROWSER_SERVICE = "browser"`; `flow({ name, input, profile? })` over `BROWSER_FLOWS` plus a catalog, in `profile` when given (`x@wren`; `autobrowse fingerprint --box` uses it) — `src/engine/browser-service.ts:48-71,117-179`
- Retry policy: same as the run object — `:44-49`
- Irreversible acts done on an earlier try are not redone: `DoneActs` keyed by durable call (`src/browser/attempt.ts:31-45`)

## Connected to

- **owned-by:** [[app]]
- **joins:** [[flow]] (the runner), [[failure-record]]
- **looks-like-but-is-not:** [[run-object]] (stateful, many steps); the site facade's browser leg (in-process, `src/sites/facade.ts`)

## If you change this

- **Hits:** `src/workflows/domain/steps.ts` (calls it), `src/browser/attempt.ts`, wren callers of `browser/*` over the ingress.
- **Does not hit:** compiled workflows (they use `App.browser` in-process, `src/workflows/compiled-deps.ts:18-30`).

## Surfaces

| Surface | Role |
|---|---|
| Restate ingress (wren, domain workflow) | calls |

## See

- Source: `src/engine/browser-service.ts`
