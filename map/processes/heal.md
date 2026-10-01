---
type: process
status: verified
verified: 2026-09-28 @ 70aefc3
consumes: [failure-record, compiled-workflow, outline, fix]
produces: [compiled-workflow, proof]
---

# heal

A compiled workflow that broke at one step is fixed in its own source, not handed to a person.

## Input → Movement → Output

A failure record from the runner. The healer finds the step and op that broke in the outline, has the agent finish that step on the live page (or applies a kept fix), patches the outline, re-renders, checks and proves. A repaired workflow with a fresh proof, or `needs-human` with the reason.

## Why this shape

A broken flow must get fixed in the flow (fallback paths, a remapped locator), never become a chore for the person. Repair at run time (the `Repairer`) buys one run; heal makes the next run deterministic.

## Steps

1. The runner writes `*.failure.json`; `App.onFailure` hands it to `healer` — `src/browser/session.ts:51`, `src/app/services.ts:406`, `src/app/backend.ts:217`
2. `locateFailure(record, root)`: which compiled dir, which outline step, which op (`brokenOp`) — `src/agent/heal.ts:72`, `src/compiler/patch.ts:29`
3. `healRequest` → the agent runs from that page toward the step's goal — `src/agent/heal.ts:103`, `src/agent/explorer.ts:140`
4. `swapHints` / `replaceOp` patches the outline; `render` writes the module — `src/compiler/patch.ts:63-90`, `src/compiler/render.ts:256`
5. `applyFixes(compiledDir, fixes, lib)` folds kept repairs into source and drops them — `src/agent/heal.ts:253`
6. `checkCompiled`, then `prove` — `src/compiler/check.ts:14`, `src/agent/heal.ts:135-224`

## If you change this

- **Hits:** `src/app/backend.ts:216-240`, `src/ui/jobs.ts` (heal runs as a job), `autobrowse repair`, `src/browser/fixes.ts`, `src/compiler/patch.ts`.
- **Does not hit:** hand-written flows (`src/browser/flows/`: fixed by hand), sign-in walks (their unknown pages are learned screens, not heals).

## Surfaces

| Surface | Role |
|---|---|
| worker, on every failure record | starts |
| `autobrowse repair`, UI | starts by hand, shows outcome |

## See

- Objects: [[failure-record]], [[compiled-workflow]], [[outline]], [[fix]], [[agent-session]], [[proof]]
- Source: `src/agent/heal.ts`
