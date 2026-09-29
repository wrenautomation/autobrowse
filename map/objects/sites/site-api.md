---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/sites/types.ts
---

# Site API

A site served under its official API's shape, with the steps that make its keys: `SiteApi` in `src/sites/types.ts`; the list is `SITES` in `src/sites/index.ts:42` (linkedin, youtube, instagram, tiktok, outlook, gmail, langfuse, meta, x, npm, calcom, web).

## Why this shape

Callers speak the official REST shape. A route has an `api` leg and, only where the API lacks the call, a `browser` leg (a hand-written flow or a compiled workflow). Setup steps make tokens the same way (`src/sites/types.ts:44-94`). `auth: {open: true}` is a keyless site (`web`: search and read, `src/sites/web.ts`), every api leg runs.

## Shape

- `SiteApi { site, origin, auth: {token}|{oauth}|{open}, routes, setup, purpose?, probe?, caps? }` — `src/sites/types.ts:148-170`; `caps` = most a route's `meter` may use per account per day (LinkedIn: profile 80, search 25, company 40)
- `SiteRoute { method, path ({param}), request (zod), api?, browser?, irreversible?, spends?, meter?, summary }` — `:44-69`; `ApiLeg { token, http, env }` — `:18-24`; `Leg = {flow}|{workflow}`, `BrowserLeg` — `:30-42`
- `SetupStep { name, makes, needs?, how: Leg+input | {oauth}, summary, purpose? }` — `:79-94`; `OAuthSpec` — `:96-146`; `SiteError { status, retryAfter? }` — `:172-182`
- Per-site files: `src/sites/<site>.ts`; `route()` erases types — `:185`

## Connected to

- **owns:** routes, setup steps, its OAuth spec
- **owned-by:** [[site-facade]]
- **joins:** [[token]] (`auth`, `makes`), [[flow]] / [[compiled-workflow]] (browser legs), [[ability]] (`kind: "site"`), [[need]] (`siteNeeds`), [[account]] (`purpose`), [[spend-policy]] (`spends`)
- **looks-like-but-is-not:** [[site-login]]; `Site` the profile name

## If you change this

- **Hits:** `src/sites/facade.ts`, `src/sites/renew.ts` (`keptBy`), `src/sites/wire.ts`, `src/app/needs.ts:59-170`, `src/do/catalog.ts:83`, `src/app/cli-site.ts`, UI `/api/sites` (`src/ui/api.ts:361-410`), wren's channel packages (they call these routes by path).
- **Does not hit:** sign-ins; the run object.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse site call/setup/check` | calls |
| wren (Restate `sites`) | calls |

## See

- Source: `src/sites/types.ts`, `src/sites/index.ts`
- Design: `designs/2026-09-21-site-apis.md`
