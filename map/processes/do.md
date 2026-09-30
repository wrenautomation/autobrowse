---
type: process
status: verified
verified: 2026-09-28 @ 70aefc3
consumes: [ability, access-key, site-api, compiled-workflow]
produces: [agent-session, compiled-workflow]
---

# do

One verb over everything: a goal in words is routed to the thing that already does it, and to the agent only when nothing does.

## Input → Movement → Output

A goal, optional inputs, site, url, `dryRun`; for an agent key, its scope. `pickAbility` chooses from the catalog (site routes, compiled workflows, flows, tools); the matching leg runs; with no match the agent explores once, and what it achieved is saved and compiled under a name for the next same ask. An outcome with `via`, the leg's answer, and the workflow built, if any.

## Why this shape

Deterministic first, model last: the model chooses among named abilities and never improvises a leg when one exists. Every explore that succeeds leaves a workflow behind, so the same ask is cheaper and repeatable the second time.

## Steps

1. `doer(deps).do(req)`: `abilities()` (cut to scope through `doAs`) — `src/do/doer.ts:107,231`, `src/app/backend.ts:132`
2. `pickAbility(llm, goal, abilities, memory)`; a remembered pick skips the model — `src/do/pick.ts:52`
3. `dryRun` → the pick and why, nothing runs — `src/do/doer.ts:249-262`
4. By kind: `callSite` → [[site-call]]; `runWorkflow` → `runCompiled` with gates approved; `runFlow`; `runTool` — `src/do/doer.ts:59-84`
5. No ability, or not ready: `explore` starts an agent session on the site, waits, `save` + `compile` — `src/do/doer.ts:163-222`
6. Restate face `do` for orchestrators; HTTP `/api/do`; CLI `autobrowse do <goal>` — `src/do/service.ts:12`, `src/ui/api.ts:313-334`, `src/app/cli-do.ts:12`

## If you change this

- **Hits:** `src/do/catalog.ts`, `src/do/pick.ts`, `src/do/tools.ts`, `src/access/fence.ts`, `src/app/backend.ts:122-134`, wren callers of Restate `do`.
- **Does not hit:** the run object; sign-ins.

## Surfaces

| Surface | Role |
|---|---|
| another agent with a key, wren, CLI, UI | callers |

## See

- Objects: [[ability]], [[access-key]], [[site-api]], [[compiled-workflow]], [[agent-session]]
- Source: `src/do/doer.ts`
