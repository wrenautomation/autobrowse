---
type: object
cluster: app
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/app/backend.ts
---

# Backend

The port the UI, the CLI and the HTTP API all talk to: `Backend` in `src/app/backend.ts`, built by `backendFor` over an `App`, or `localBackend` for a CLI that talks to a running worker.

## Why this shape

Every face reads the same shape: workflows and proofs (value or loader), prove, heal, outline, compile, finish, agent sessions, sites, accounts, `do`, `doAs`, ledger, owed, policy. A field is optional when the process lacks the dep (no model, no browser).

## Shape

- `Backend` — `src/app/backend.ts:89-141`; `workflowsOf`, `proofsOf` — `:144-147`
- `proveCompiled` `:150`, `compileRecording` `:164`, `finishCompiled` `:192`, `healer` `:216`, `explorerOpener` `:246`, `agentFor` `:284`
- `BackendParts`, `localParts`, `BackendOptions`, `backendFor`, `LocalOptions`, `localBackend` — `:314-472`
- Faces: `api(deps: ApiDeps extends Backend)` — `src/ui/api.ts:48,143`; `Jobs` (prove and heal run here) — `src/ui/jobs.ts:30`; the CLI client `src/app/client.ts`

## Connected to

- **owned-by:** [[app]]
- **joins:** [[compiled-workflow]], [[proof]], [[outline]], [[agent-session]], [[site-facade]], [[account]], [[ability]], [[access-key]], [[need]] (`owed`, `policy`)
- **looks-like-but-is-not:** the Restate endpoint (`App.services`)

## If you change this

- **Hits:** `src/ui/api.ts`, `src/ui/jobs.ts`, `src/app/client.ts`, every `src/app/cli-*.ts` that goes through it, `ui/src/api.ts` (the SPA's client), `test/api.test.ts`.
- **Does not hit:** Restate handlers; flows.

## Surfaces

| Surface | Role |
|---|---|
| HTTP API (`/api/*`), SPA, CLI | call |

## See

- Source: `src/app/backend.ts`, `src/ui/api.ts`
