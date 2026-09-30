---
type: object
cluster: access
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/do/catalog.ts
---

# Ability

One thing `do` can pick: a site route, a compiled workflow, a hand-written flow or a command-line tool: `Ability` from `abilitiesOf` in `src/do/catalog.ts`. The verb itself is `Doer` in `src/do/doer.ts`.

## Why this shape

"One verb over everything": a goal is routed to what already does it, deterministically; only when nothing fits does the agent explore, and what it did compiles into a workflow for the next same ask (`DoOutcome.built`, `src/do/doer.ts:33-47`).

## Shape

- `AbilityKind = site | workflow | flow | tool`; `Ability { kind, name, site, summary, inputs, irreversible, ready, missing }` — `src/do/catalog.ts:12-30`; `siteAbilityName`, `parseSiteAbility`, `fieldsOf` — `:28-72`; `AbilitySources`, `abilitiesOf` — `:74-83`
- `DoRequest { goal, inputs?, site?, url?, dryRun? }`; `DoVia`; `DoOutcome`; `DoError` — `src/do/doer.ts:19-57`; `DoerDeps { llm, abilities, sites, callSite, runWorkflow, runFlow, runTool?, memory?, agent?, compile? }` — `:59-84`; `doer(d)` — `:107`
- The pick: `Pick`, `pickAbility` (a model chooses, earlier picks remembered) — `src/do/pick.ts:11-52`
- Restate: `DO_SERVICE = "do"`, `doService` — `src/do/service.ts:12-22`

## Connected to

- **owned-by:** [[backend]] (`do`, `abilities`, `doAs`); [[app]] (`App.doer`)
- **joins:** [[site-api]], [[compiled-workflow]], [[flow]], [[agent-session]], [[access-key]] (scope cuts the catalog), the LLM seam
- **looks-like-but-is-not:** a [[workflow]] step; the MCP tool list (leftover)

## If you change this

- **Hits:** `src/do/doer.ts`, `src/do/pick.ts`, `src/do/service.ts`, `src/do/tools.ts`, `src/app/backend.ts:121-133`, `src/app/cli-do.ts`, UI `/api/abilities`, `/api/do` (`src/ui/api.ts:313-334`), `src/access/fence.ts`, wren callers of Restate `do`.
- **Does not hit:** the run object; sign-ins.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse do`, UI, Restate `do`, wren | call |

## See

- Source: `src/do/catalog.ts`, `src/do/doer.ts`
