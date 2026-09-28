---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/sites/facade.ts
---

# Site facade

The one instance that runs a site call, a setup step or a renewal, shared by the CLI, the HTTP API and the Restate service `sites`: `SiteFacade` from `siteFacade` in `src/sites/facade.ts`, wired by `sitesFor` in `src/sites/wire.ts`.

## Why this shape

One place picks the account, mints the bearer, matches the path, asks the spend policy, and falls to the browser leg. The Restate face (`sitesService`) means an orchestrator on the same Restate queues a call while the box is down and a write runs once.

## Shape

- `SiteFacade { list, status, call(site, method, path, input, account?), setup(site, step, account?, profile?, input?), renew? }` — `src/sites/facade.ts:106-133`
- `SiteFacadeDeps { http, env, sink, runner, flow, compiled?, oauthPort?, profileFor?, providerOf?, accountFor?, approve? }` — `:29-68`; `matchPath` — `:173`; `checkSite` — `:144`
- `SiteParts` (what `sitesFor` needs, including `reload` for tokens minted elsewhere) — `src/sites/wire.ts:28-63`
- Restate: `SITES_SERVICE = "sites"`, `sitesService(facade)` — `src/sites/service.ts:15-95`
- Paths are interpolated by the caller; a template path plus a param in the input is HTTP 400

## Connected to

- **owns:** the call path
- **owned-by:** [[app]] (`App.sites`), [[backend]] (`sites`)
- **joins:** [[site-api]], [[token]], [[account]], [[flow]] (browser legs), [[compiled-workflow]] (`compiled.run`), [[approval]] (`approve`), [[ability]] (site abilities call it)
- **looks-like-but-is-not:** [[browser-service]]

## If you change this

- **Hits:** `src/sites/wire.ts`, `src/sites/service.ts`, `src/app/cli-site.ts`, `src/ui/api.ts:361-410`, `src/do/doer.ts` (`callSite`), `src/app/needs.ts`, wren's `Content` service and channel packages (Restate `sites/call`, `sites/status`, `sites/setup`).
- **Does not hit:** sign-ins; the run object.

## Surfaces

| Surface | Role |
|---|---|
| CLI `site`, UI `/api/sites`, Restate `sites` | call |
| wren (outside the tree) | calls over the shared Restate ingress |

## See

- Source: `src/sites/facade.ts`, `src/sites/wire.ts`, `src/sites/service.ts`
