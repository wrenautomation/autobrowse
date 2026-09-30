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

- `App { services, channel, workflows(), proofs(), catalog, browser, bus, memory, sink, sites, idle, screen, credentials, onFailure, doer }` — `src/app/services.ts:370-403`; `buildApp(settings, log)` — `:1034`
- Factories: `browserOptions` `:247`, `llmFor` `:330`, `credentialsFor` `:418`, `codesFor` `:551`, `loginFor` `:598`, `envStoreFor` `:844`, `approverFor` `:941`, `channelsFor` `:1010`, wallet and profiles `:694-722`
- `src/app/main.ts`: `buildApp` → Restate endpoint (`planEndpoint`, `registerDeployment` `src/app/register.ts:11`) → `startUiServer` (`src/ui/server.ts:34`) → `scheduleIdleStop` (`src/app/idle.ts:70`) and `selfStopper` (the box stops its own instance, `src/app/box.ts:67`)
- Restate services registered: run objects (hand-written), `Compiled`, `Runs`, `browser`, `sites`, `do`
- `src/app/desk.ts`: the Mac's lean worker, only `sitesService(app.sites, "desk")` (`src/sites/service.ts:58`) on its own tunnel name in the box's Restate environment; no UI, idle stop or evaluator. launchd keeps it up (`deploy/desk/install.sh`); the agent needs node to have Full Disk Access (the repo is under ~/Documents)
- Library surface for other code: `src/index.ts` and the package `exports` (`.`, `./sites`, `./auth`, `./do`, `./agent`, `./flows`, `./llm`); bin `dist/app/cli.js`

## Connected to

- **owns:** every service instance
- **owned-by:** the process
- **joins:** [[settings]], [[backend]] (the UI's port over the app), [[run-object]], [[runs-registry]], [[browser-service]], [[site-facade]], [[ability]], [[channel]], [[credential]], [[flow]] (`App.browser`)

## If you change this

- **Hits:** `src/app/main.ts`, `src/app/backend.ts:329-469` (`localParts`, `backendFor`, `localBackend`), every `src/app/cli-*.ts`, `src/app/status.ts`, `test/` fixtures that build parts.
- **Does not hit:** the engine's types; flows.

## Surfaces

| Surface | Role |
|---|---|
| worker (`tsx src/app/main.ts`, `deploy/worker-entry.sh`) | builds once |
| desk (`pnpm desk`, launchd on the Mac) | builds once, serves `desk` |
| CLI | builds what a verb needs |

## See

- Source: `src/app/services.ts`, `src/app/main.ts`
- Design: `designs/2026-09-19-deploy.md`
