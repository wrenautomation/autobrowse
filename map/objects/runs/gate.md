---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/engine/effects.ts
---

# Gate

A question a run leaves open for a person: `GateName` in `src/engine/effects.ts`, stored as state, never a parked invocation.

## Why this shape

A step whose gate has no answer throws `GateOpen`; the host records it and returns. The answer arrives as a new invocation, so pause, reset and status always run (`src/engine/effects.ts:1-11`).

## Shape

- Names: `purchase | password | send | choose | human`; `human` is the host's (a step threw `NeedsHuman`), the others a step asks for — `src/engine/effects.ts:28-31`
- `GateAnswer { approved, note, at }` — `:33-37`; `GateOpen(gate, prompt)` — `:40`
- `OpenGate` (the stored open one) and `Answers` keyed by gate name under `KEYS` — `src/engine/run.ts:14-46`
- Guards `purchase | password | irreversible` can be turned off per run (`AdvanceOptions.guards`) — `src/engine/guards.ts:8-10`, `src/engine/run.ts:92-95`
- `applyAnswer`: a no rejects the step; a yes on `human` reruns it; otherwise the answer is stored and the step reruns and reads it — `src/engine/run.ts:184-207`

## Connected to

- **owns:** nothing
- **owned-by:** [[run-object]] (state), [[workflow]] (steps ask)
- **joins:** [[run-event]] (`gate-opened`, `gate-answered`), [[channel]] (a `yes`/`no` reply is the answer)
- **looks-like-but-is-not:** [[approval]] (`PaymentGate`: one browser act that spends, asked by the explore session or the runner, no Restate state)

## If you change this

- **Hits:** `src/engine/run.ts` (advance, applyAnswer), `src/engine/object.ts:151-163` (approve/reject handlers), `src/channels/commands.ts:31`, UI `/api/runs/:workflow/:key/:action` (`src/ui/api.ts:468`), `src/compiler/render.ts` (renders `send` gates).
- **Does not hit:** `src/gates/payment.ts`, `src/gates/spend.ts`, the site facade's `spends` check.

## Surfaces

| Surface | Role |
|---|---|
| a person, on any channel | answers |
| UI runs page, CLI | approve / reject |

## See

- Source: `src/engine/effects.ts`, `src/engine/run.ts`
