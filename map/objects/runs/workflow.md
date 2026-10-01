---
type: object
cluster: runs
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/engine/workflow.ts
---

# Workflow

A named list of steps over a zod plan, run one step per host invocation: `Workflow<P,D,M,S>` in `src/engine/workflow.ts`. The CLI verb, the Restate object name and the `do` ability all use its `name`.

## Why this shape

Steps never see Restate. A workflow is data plus step functions over the `Effects` seam, so the same code runs in a unit test (`src/engine/memory.ts`) and on Restate (`src/engine/object.ts`).

## Shape

- `name`, `description`, `plan: z.ZodType<P>` (every plan carries `dryRun`), `steps[]`, `emptyMemo()`, optional `settle(plan, memo)` — `src/engine/workflow.ts:42-62`
- `StepDef.run(ctx)` returns `done | skipped | rejected` with a detail line; `irreversible` marks money or accounts — `src/engine/workflow.ts:16-40`
- `StepCtx` = `fx`, `deps`, `plan`, `memo`, `gate(name, prompt)` — `src/engine/workflow.ts:25-32`
- Hand-written: `domain`, `bootstrap` (`HAND_WRITTEN`, `src/workflows/compiled.ts:28`). Every other dir under `src/workflows/` is compiled.

## Connected to

- **owns:** its steps; its plan schema (`src/engine/inputs.ts:49` turns it into CLI and UI fields)
- **owned-by:** [[run-object]] (one per hand-written workflow; compiled ones share one `Compiled` object)
- **joins:** [[gate]] (a step asks through `ctx.gate`), [[compiled-workflow]] (a rendered module exports one), [[ability]] (`kind: "workflow"`)
- **looks-like-but-is-not:** [[flow]] (`BrowserFlow`: one browser leg, no journal, no gates); a walk (`src/browser/screens.ts`)

## If you change this

- **Hits:** `src/engine/run.ts` (advance and nextStep read `steps` and `settle`), `src/engine/object.ts`, `src/compiler/render.ts:256-340` (emits this shape), `src/engine/inputs.ts`, `src/do/catalog.ts:83`, every `src/workflows/*/index.ts`.
- **Does not hit:** `src/browser/flow.ts` or the flow runner; site routes that name a workflow by string (`src/sites/types.ts:42`).

## Surfaces

| Surface | Role |
|---|---|
| CLI `run`, `try`, `workflows` (`src/app/cli.ts:99-161`) | starts, lists |
| UI `/api/workflows`, `/api/runs` (`src/ui/api.ts:222,437`) | lists, starts |
| wren, over the Restate ingress | starts runs by object name |

## See

- Source: `src/engine/workflow.ts`
