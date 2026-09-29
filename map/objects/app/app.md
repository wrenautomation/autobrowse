---
type: object
cluster: app
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/app/services.ts
---

# App

The composition root: every service, store and seam built once from settings, lazily: `App` from `buildApp` in `src/app/services.ts`; the worker process is `src/app/main.ts`.

## Why this shape

Deps are made in one file so the CLI, the worker and tests share the same wiring; a CLI command imports only what it needs so start stays fast (`src/app/cli-*.ts`, lazy imports).

## Shape

- `App { services, channel, workflows(), proofs(), catalog, browser, bus, memory, sink, sites, idle, screen, credentials, onFailure, doer }` — `src/app/services.ts:363-403`; `buildApp(settings, log)` — `:999`
- Factories: `browserOptions` `:242`, `llmFor` `:322`, `credentialsFor` `:410`, `codesFor` `:536`, `loginFor` `:579`, `envStoreFor` `:815`, `approverFor` `:906`, `channelsFor` `:975`, wallet and profiles `:669-698`
- `src/app/main.ts`: `buildApp` → Restate endpoint (`planEndpoint`, `registerDeployment` `src/app/register.ts:11`) → `startUiServer` (`src/ui/server.ts:34`) → `scheduleIdleStop` (`src/app/idle.ts:70`) and `selfStopper` (the box stops its own instance, `src/app/box.ts:67`)
- Restate services registered: run objects (hand-written), `Compiled`, `Runs`, `browser`, `sites`, `do`
- Library surface for other code: `src/index.ts` and the package `exports` (`.`, `./sites`, `./auth`, `./do`, `./agent`, `./flows`, `./llm`); bin `dist/app/cli.js`

## Connected to

- **owns:** every service instance
- **owned-by:** the process
- **joins:** [[settings]], [[backend]] (the UI's port over the app), [[run-object]], [[runs-registry]], [[browser-service]], [[site-facade]], [[ability]], [[channel]], [[credential]], [[flow]] (`App.browser`)

## If you change this

- **Hits:** `src/app/main.ts`, `src/app/backend.ts:327-460` (`localParts`, `backendFor`, `localBackend`), every `src/app/cli-*.ts`, `src/app/status.ts`, `test/` fixtures that build parts.
- **Does not hit:** the engine's types; flows.

## Surfaces

| Surface | Role |
|---|---|
| worker (`tsx src/app/main.ts`, `Dockerfile:28`) | builds once |
| CLI | builds what a verb needs |

## See

- Source: `src/app/services.ts`, `src/app/main.ts`
- Design: `designs/2026-09-19-deploy.md`
