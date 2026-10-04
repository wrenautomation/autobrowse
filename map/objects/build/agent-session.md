---
type: object
cluster: build
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/agent/sessions.ts
---

# Agent session

A model exploring a site toward a goal, one act a step, with play, pause, a person's own commands and a save into a recording: `AgentSessions` / `SessionView` in `src/agent/sessions.ts`; the loop is `exploreWithAgent` in `src/agent/explorer.ts`.

## Why this shape

Play-pause: a human or the model drives, every act is journaled the same way, so a session can be paused, taken over, resumed and saved. A session that dies is resumed from its ledger rows (`prior`).

## Shape

- `SessionStatus` (starting … needs-human … closed); `SessionView`; `StartRequest`; `AgentSessions { start, list, get, pause, resume, stop, save, exec, close, flush }` — `src/agent/sessions.ts:18-90`; `AGENT = "agent"` — `:136`
- `AgentOptions { explorer, llm, goal, inputs, secrets, maxSteps, ledger, session, prior, stopped, onHuman, maxRefs }` — `src/agent/explorer.ts:69-95`; `StepRecord` — `:57-67`
- What the model sees: `digest(aria)` with refs, `pageForModel` — `src/agent/digest.ts:213,421`
- Ledger: `StepLedger` rows in `~/.config/autobrowse/steps.jsonl` — `src/agent/ledger.ts:10-46`; `stepLedgerFor` `src/app/services.ts:616`; OTLP trace sink `traceSinkFor` `:289`
- Made by `agentFor` — `src/app/backend.ts:291`

## Connected to

- **owns:** its steps and journal
- **owned-by:** [[backend]] (`agent`)
- **joins:** [[explore-session]], [[recording]], [[proposal]] (evidence), the LLM seam (`src/llm/types.ts:41`), the `do` verb (`via: "agent"`), heal (the agent finishes a broken step)
- **looks-like-but-is-not:** browser [[session]]; a Restate run

## If you change this

- **Hits:** `src/agent/explorer.ts`, `src/agent/heal.ts`, `src/agent/builder.ts`, `src/do/doer.ts`, `src/app/backend.ts:291`, UI `/api/agent/*` (`src/ui/api.ts:710-825`), `src/app/cli-do.ts`.
- **Does not hit:** the runner's repair path; compiled workflows already rendered.

## Surfaces

| Surface | Role |
|---|---|
| UI Agent page, `autobrowse do`, heal | start, steer |
| a person | pause, exec, resume |

## See

- Source: `src/agent/sessions.ts`, `src/agent/explorer.ts`
