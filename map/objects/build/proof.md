---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/workflows/proof.ts
---

# Proof

One in-process run of a compiled workflow on its plan defaults, kept as `proof.json` beside it: `Proof`, `runCompiled`, `proveWorkflow` in `src/workflows/proof.ts`.

## Why this shape

A proof never buys: gates are declined. The same runner with gates approved is how the site facade and `do` run a compiled workflow the caller already gated (`runCompiled`, `src/workflows/proof.ts:49-78`). The catalog shows the last proof so a draft nobody ran is visible.

## Shape

- `Proof { at, status, steps[{name, status, detail}], output }` — `src/workflows/proof.ts:18-25`; `PROOF_FILE` — `:16`; `RunAs { site, profile }` and `runnerAs` (a second account at the provider) — `:35-47`
- `writeProof`, `readProof`, `proofLine` — `:89-104`; `proveCompiled` — `src/app/backend.ts:150`; jobs run it (`src/ui/jobs.ts:30`)

## Connected to

- **owned-by:** [[compiled-workflow]]
- **joins:** [[flow]] (`App.browser`), [[gate]] (declined), [[site-facade]] (`CompiledRun`)
- **looks-like-but-is-not:** a run on Restate (a proof has an in-memory journal)

## If you change this

- **Hits:** `src/workflows/compiled.ts` (catalog reads it), `src/app/backend.ts:150`, `src/sites/facade.ts:84`, `src/do/doer.ts` (`runWorkflow`), UI `/api/workflows/:name/prove` (`src/ui/api.ts:335`), `src/agent/heal.ts` (`prove`).
- **Does not hit:** the run object; hand-written workflows.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse prove`, UI, heal | write |
| catalog, `do` | read |

## See

- Source: `src/workflows/proof.ts`
