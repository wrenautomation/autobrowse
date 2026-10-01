---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/workflows/compiled.ts
---

# Compiled workflow

A workflow rendered from an outline into `src/workflows/<name>/index.ts`, served as it appears through one Restate object `Compiled`: `CompiledWorkflow` and `makeCompiledRunObject` in `src/workflows/compiled.ts`.

## Why this shape

Rendered source is the truth from then on (the header in each module says so). One object keyed `<workflow>/<key>` serves every compiled workflow, so a compile shows up without a restart or a re-registration (`src/workflows/compiled.ts:72-106`).

## Shape

- `CompiledWorkflow { workflow, dir, proof }`; `loadCompiledWorkflows(root)`; `HAND_WRITTEN` — `src/workflows/compiled.ts:28-71`; `COMPILED_OBJECT`, `splitCompiledKey`, `CompiledCatalog`, `compiledCatalog` — `:72-104`
- Dir: `COMPILED_DIR = "src/workflows"`, modules import the library as `COMPILED_LIB = "../../index.js"` — `src/app/services.ts:374-375`
- Deps a rendered module gets: `CompiledDeps { browser, secrets, shell, desktop, sink }`, browser bound to the flow's site — `src/workflows/compiled-deps.ts:18-40`
- Render → check → finish: `render` `src/compiler/render.ts:256`; `checkCompiled` (tsc + vitest) `src/compiler/check.ts:14`; `finish` (a model fills plan inputs, send gate, proof reads, `dropped()` guard) `src/compiler/finish.ts:131-210`; `compileRecording`, `finishCompiled` `src/app/backend.ts:164-214`
- Files per dir: `index.ts`, `index.test.ts`, `outline.json`, `proof.json`

## Connected to

- **owns:** its dir and proof
- **owned-by:** [[app]] (`App.catalog`, `App.workflows()`)
- **joins:** [[workflow]], [[outline]], [[proof]], [[run-object]] (`Compiled`), [[site-api]] (`{ workflow }` legs), [[ability]], [[fix]] (patched), [[guard]]
- **looks-like-but-is-not:** a hand-written workflow (`domain`, `bootstrap`); a [[flow]]

## If you change this

- **Hits:** `src/compiler/render.ts` (what future modules look like), `src/index.ts` (what rendered modules import; an export removed there breaks every module), `src/workflows/compiled-deps.ts`, `src/workflows/proof.ts`, `src/agent/heal.ts`, `src/do/catalog.ts`, `src/sites/facade.ts` (`compiled.run`), `src/app/services.ts:374`.
- **Does not hit:** `src/workflows/domain`, `src/workflows/bootstrap`; the browser service.

## Surfaces

| Surface | Role |
|---|---|
| compiler, heal, `autobrowse compile` | write |
| Restate `Compiled`, site facade, `do`, UI | run |

## See

- Source: `src/workflows/compiled.ts`, `src/compiler/render.ts`
