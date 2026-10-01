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

1. `call(site, method, path, input, account?)` → `matchPath(route.path, path)` — `src/sites/facade.ts:133-163,203`
2. Account: `accountFor(site, purpose, account)` → `accountForSite`, `policyAccount` — `src/sites/wire.ts:83-104`; `signedOut` sites take none; a `via` site takes the account at that provider (`consentProviderOf`, `src/sites/wire.ts:68`) and its browser leg runs in that account's provider profile — `src/sites/facade.ts:490`
3. Leg: the API when a token is in hand, unless the route has `prefer: "browser"` (X reads: the API bills them). A browser-leg call books its `pace` slot (429 past 2 minutes out), then takes its `meter` from the day's `caps`, the account's `accountCaps` over them (429 over) — `src/sites/facade.ts:429-476`, `src/sites/caps.ts:136-198`; it sleeps until the slot just before the browser runs
4. `route.spends` → `approve` (the payment gate policed by the spend policy) before anything runs — `src/sites/facade.ts:33-82`, `src/gates/spend.ts:197`
5. API leg: `accessTokens` mints from the refresh token or reads the key by `accountEnv`, a miss reloads the env store once — `src/sites/oauth.ts:80-135`, `src/sites/wire.ts:53-66`; then `http(...)` with `safeUrl` (never a key in a URL) — `src/clients/http.ts:59-72`; `safeUrls` does the same to every URL in a `LoginFailed` or `NeedsHuman` message
6. Browser leg: `{ flow }` → `flow(name, input)` on the worker's runner, `{ workflow }` → `compiled.run(name, plan)` (gates approved by the caller) — `src/sites/types.ts:32-44`, `src/workflows/proof.ts:49`
7. `setup(site, step, …)` mints a token the same way and keeps it through the sink under the account's name — `src/sites/facade.ts:148`, `src/sites/oauth.ts:203`; an OAuth consent opens in the account's provider profile for a `via` site (TikTok), like its browser legs — `src/sites/facade.ts:567-571`
8. Restate face: `sites/call`, `sites/status`, `sites/setup`, `sites/renew` — `src/sites/service.ts:61-121`; the same handlers as `desk/*` from the Mac (`src/app/desk.ts`) for legs a site refuses from the box's IP (Reddit)

## If you change this

- **Hits:** `src/sites/wire.ts`, `src/sites/service.ts`, `src/app/cli-site.ts`, `src/ui/api.ts:370-419`, `src/do/doer.ts` (`callSite`), wren's channel packages (they call these paths over the ingress).
- **Does not hit:** sign-ins (a browser leg gets the wall hook from the runner); the run object.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse site call/setup/renew`, `/api/sites`, Restate `sites` | callers |
| wren `Content` service | caller, outside the tree |

## See

- Objects: [[site-api]], [[site-facade]], [[token]], [[account]], [[approval]], [[spend-policy]]
- Source: `src/sites/facade.ts`, `src/sites/service.ts`
