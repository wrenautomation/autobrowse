---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/engine/object.ts
---

# Run object

One Restate virtual object per run, keyed by the run's key: `makeRunObject` / `makeRunObjectFrom` in `src/engine/object.ts`. Product word: "a run".

## Why this shape

Each handler is one host invocation and state is saved before it returns (`src/engine/run.ts:97`). Transient failures retry with backoff for about a day; `Unrecoverable`, `NeedsHuman`, `FlowFailed` and 4xx stop at once (`src/engine/object.ts:67-84`).

## Shape

- Handlers: `run`, `step`, `pause`, `play`, `approve`, `reject`, `reset`, `status` — `src/engine/object.ts:158-167`
- State keys: results, memo, answers, the open gate — `src/engine/run.ts:14-19`
- `HostDeps.emit(event, feed?)` journals every [[run-event]]; `registry: false` in tests — `src/engine/object.ts:52-63`
- Feed: `run` with `x-feed-url`/`x-feed-tag`/`traceparent` keeps the caller's hook in state `feed` (a host off `HostDeps.feedHosts` is a 400 before anything runs); every emit hands it on with `seq` counted from 1; `reset` keeps it; a step with a `traceparent` runs under `HostDeps.traced` so model spans join the caller's trace — `src/engine/object.ts:226-240`, `:295`, `:333-334`, `src/engine/feed.ts:47-68`
- `makeRunObjectFrom(name, resolve)`: one object serves many workflows found per key (the compiled ones) — `src/engine/object.ts:204`, `src/workflows/compiled.ts:106`
- `Effects` seam a step gets: `run`, `get`, `set`, `clear`, `sleep`, `now` — `src/engine/effects.ts:12-21`

## Connected to

- **owns:** run state; the [[gate]] that is open
- **owned-by:** [[app]] (`App.services`)
- **joins:** [[runs-registry]] (every event), [[workflow]], [[compiled-workflow]]
- **looks-like-but-is-not:** [[browser-service]] (a stateless Restate service for one flow), an agent session

## If you change this

- **Hits:** `src/engine/run.ts`, `src/engine/memory.ts` (the test host), `src/workflows/compiled.ts`, `src/app/services.ts:1191` (`buildApp` registers them), CLI `run`/`status`, UI `/api/runs`, `src/app/client.ts`.
- **Does not hit:** flows, the site facade, agent sessions (in-process, not Restate).

## Surfaces

| Surface | Role |
|---|---|
| Restate | hosts, retries, journals |
| CLI, UI, wren ingress calls | invoke handlers |

## See

- Source: `src/engine/object.ts`, `src/engine/run.ts`
