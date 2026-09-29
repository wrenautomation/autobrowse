---
type: process
status: verified
verified: 2026-09-28 @ 70aefc3
consumes: [site-api, token, account, spend-policy]
produces: [approval]
---

# site-call

A caller speaks a site's official API shape; the facade runs it by API, or by browser where the API has no such call.

## Input → Movement → Output

Site, method, path (interpolated), input, optional account. The facade matches the route, picks the account (named, or by the site's purpose), asks the spend policy when the route spends, mints a bearer for the API leg or runs the browser leg (a flow or a compiled workflow) signed in as that account. The API body, or the leg's read, comes back; a missing token is a `SiteError` naming the setup step.

## Why this shape

One shape for everyone (CLI, HTTP, Restate `sites`, wren): the caller never knows whether a browser was involved. A template path with a param in the input is a 400 on purpose, so no caller depends on interpolation the facade would have to guess.

## Steps

1. `call(site, method, path, input, account?)` → `matchPath(route.path, path)` — `src/sites/facade.ts:115-142,182`
2. Account: `accountFor(site, purpose, account)` → `accountForSite`, `policyAccount` — `src/sites/wire.ts:82-103`
3. `route.spends` → `approve` (the payment gate policed by the spend policy) before anything runs — `src/sites/facade.ts:30-77`, `src/gates/spend.ts:197`
4. API leg: `accessTokens` mints from the refresh token or reads the key by `accountEnv`, a miss reloads the env store once — `src/sites/oauth.ts:74-129`, `src/sites/wire.ts:53-66`; then `http(...)` with `safeUrl` (never a key in a URL) — `src/clients/http.ts:52-60`
5. Browser leg: `{ flow }` → `flow(name, input)` on the worker's runner, `{ workflow }` → `compiled.run(name, plan)` (gates approved by the caller) — `src/sites/types.ts:30-42`, `src/workflows/proof.ts:49`
6. `setup(site, step, …)` mints a token the same way and keeps it through the sink under the account's name — `src/sites/facade.ts:127`, `src/sites/oauth.ts:197`
7. Restate face: `sites/call`, `sites/status`, `sites/setup`, `sites/renew` — `src/sites/service.ts:55-95`

## If you change this

- **Hits:** `src/sites/wire.ts`, `src/sites/service.ts`, `src/app/cli-site.ts`, `src/ui/api.ts:361-410`, `src/do/doer.ts` (`callSite`), wren's channel packages (they call these paths over the ingress).
- **Does not hit:** sign-ins (a browser leg gets the wall hook from the runner); the run object.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse site call/setup/renew`, `/api/sites`, Restate `sites` | callers |
| wren `Content` service | caller, outside the tree |

## See

- Objects: [[site-api]], [[site-facade]], [[token]], [[account]], [[approval]], [[spend-policy]]
- Source: `src/sites/facade.ts`, `src/sites/service.ts`
