---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/sites/types.ts
---

# Site API

A site served under its official API's shape, with the steps that make its keys: `SiteApi` in `src/sites/types.ts`; the list is `SITES` in `src/sites/index.ts:42` (linkedin, youtube, instagram, tiktok, outlook, gmail, langfuse, meta, x, npm, calcom).

## Why this shape

Callers speak the official REST shape. A route has an `api` leg and, only where the API lacks the call, a `browser` leg (a hand-written flow or a compiled workflow). Setup steps make tokens the same way (`src/sites/types.ts:44-88`).

## Shape

- `SiteApi { site, origin, auth: {token}|{oauth}, routes, setup, purpose?, probe? }` — `src/sites/types.ts:142-158`
- `SiteRoute { method, path ({param}), request (zod), api?, browser?, irreversible?, spends?, summary }` — `:44-69`; `ApiLeg { token, http, env }` — `:18-24`; `Leg = {flow}|{workflow}`, `BrowserLeg` — `:30-42`
- `SetupStep { name, makes, needs?, how: Leg+input | {oauth}, summary, purpose? }` — `:73-88`; `OAuthSpec` — `:90-140`
- Per-site files: `src/sites/<site>.ts`; `route()` erases types — `:170`

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
