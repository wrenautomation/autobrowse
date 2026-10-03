---
type: process
status: verified
verified: 2026-09-28 @ 70aefc3
consumes: [workflow, gate, run-object]
produces: [run-event, runs-registry]
---

# run-step

One host invocation moves a run by one step, saves, and asks for the next invocation.

## Input → Movement → Output

A run object with saved results, memo and answers; a workflow found by name or key. `advance` picks the next step, runs it with the answers it has, records the result and emits an event; a step that needs a gate throws `GateOpen` and the run waits as state. A finished run settles and the registry row shows it.

## Why this shape

A parked invocation would hold a Restate slot for days and could not be paused, reset or asked for status. State-then-return means a laptop that dies mid-run resumes on the next start, and an answer from any channel is just another invocation.

## Steps

1. `run(plan)` stores the plan and calls `step` — `src/engine/object.ts:158-201`
2. `advance(fx, w, deps, o)`: `nextStep` (first not done), run it under `fx.run` so Restate journals it — `src/engine/run.ts:67-180`
3. `ctx.gate(name, prompt)`: an answer is read from state; none → `GateOpen`, stored as the open gate, event `gate-opened`, return — `src/engine/run.ts:120-170`, `src/engine/effects.ts:40`
4. `approve` / `reject` → `applyAnswer` (a no rejects the step, a yes on `human` reruns, else the answer is stored) then `step` again — `src/engine/run.ts:184-207`
5. Errors: retry with backoff (`RETRY`), or stop on `unrecoverable` (`Unrecoverable`, `NeedsHuman`, `FlowFailed`, 4xx) — `src/engine/object.ts:67-84`
6. Every change → `HostDeps.emit` → channels, the UI bus and `Runs.record` — `src/engine/object.ts:52-63`, `src/engine/registry.ts:52-57`
7. Last step done → `settle`, `finished` event with `outcomeOf` — `src/engine/run.ts:212-244`

## If you change this

- **Hits:** `src/engine/object.ts`, `src/engine/memory.ts` (the test host must match), `src/workflows/compiled.ts:107`, `src/compiler/render.ts` (what a rendered step may do), `src/channels/commands.ts`, UI runs page.
- **Does not hit:** the browser runner (a flow is one step's body), site calls.

## Surfaces

| Surface | Role |
|---|---|
| Restate | invokes, journals, retries |
| CLI `run`, UI, wren ingress calls | start, answer |

## See

- Objects: [[workflow]], [[gate]], [[run-object]], [[run-event]], [[runs-registry]]
- Source: `src/engine/run.ts`, `src/engine/object.ts`
