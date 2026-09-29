---
type: process
status: verified
verified: 2026-09-28 @ 70aefc3
consumes: [settings, app]
produces: []
---

# deploy

A push to main becomes the worker running on the box, registered with Restate Cloud, and the box stops itself when idle.

## Input → Movement → Output

A green `ci` run on main. The deploy workflow builds the image, pushes it to ECR, starts the box, ships the compose file and deploy script over SSM, runs the deploy script (fresh env from SSM, pull, restart), then releases the box. The worker boots, registers its endpoint with Restate, serves the UI, and stops the instance after 30 idle minutes unless a person started it.

## Why this shape

The box bills only while running. A deploy starts it and lets the worker's own idle stop end it; a box a person started is never stopped by code. Compose is the deploy unit; the only other copy of the compose file is first boot's user data.

## Steps

1. `.github/workflows/ci.yml` (lint, typecheck, build:check, ui:build, test) → `.github/workflows/deploy.yml` on `workflow_run` success — `.github/workflows/deploy.yml:6-12`
2. `docker build` → push `$GITHUB_SHA` and `latest` to ECR — `.github/workflows/deploy.yml:28-33`; the image carries Google Chrome (amd64) and Xvfb; CMD `deploy/worker-entry.sh` starts a virtual screen, then `tsx src/app/main.ts` — `Dockerfile:18-38`, `deploy/worker-entry.sh`; compose runs it headed Chrome in `America/New_York` — `deploy/compose.prod.yml`
3. `deploy/scripts/box.sh start` with `BOX_STARTED_BY=deploy` (a tag; a person's start has no such tag) — `deploy/scripts/box.sh:7-9,27-40`
4. SSM `send-command`: write `compose.yml` and `autobrowse-deploy`, run it with the sha — `.github/workflows/deploy.yml:39-62`; the script pulls, gives `/data` to the image's pwuser uid (1001 now, 1000 once), and restarts; the running image stays if the pull fails — `deploy/scripts/on-box-deploy.sh:33-47`
5. The worker: `buildApp` → `planEndpoint` (tunnel to Restate Cloud, or listen) → `registerDeployment` → `startUiServer` → `scheduleIdleStop` + `selfStopper` — `src/app/main.ts`, `src/app/endpoint.ts:39`, `src/app/register.ts:11`, `src/ui/server.ts:34`, `src/app/idle.ts:70`, `src/app/box.ts:67`
6. Infra is `deploy/terraform/` (`box.tf`, `ci.tf`, `shots.tf`); state is local and never committed

## If you change this

- **Hits:** `deploy/compose.prod.yml`, `deploy/prod.env.example`, `deploy/README.md`, `README.md` (deploy section), wren (it wakes this box by instance id before a `sites` call: `packages/config/src/index.ts`, `WREN_AUTOBROWSE_INSTANCE_ID`).
- **Does not hit:** `compose.yml` at the root (local dev), the CLI.

## Surfaces

| Surface | Role |
|---|---|
| GitHub Actions | runs on push |
| `deploy/scripts/box.sh start|stop|release|status` | a person's hand on the box |

## See

- Objects: [[settings]], [[app]]
- Source: `.github/workflows/deploy.yml`, `deploy/scripts/`
- Design: `designs/2026-09-19-deploy.md`
