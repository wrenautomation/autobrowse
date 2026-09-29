---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-09-29 @ 75d7bc1+
entity: src/sites/types.ts
---

# Site API

A site served under its official API's shape, with the steps that make its keys: `SiteApi` in `src/sites/types.ts`; the list is `SITES` in `src/sites/index.ts:42` (linkedin, youtube, instagram, tiktok, outlook, gmail, langfuse, meta, x, npm, calcom, web).

## Why this shape

Callers speak the official REST shape. A route has an `api` leg and, only where the API lacks the call, a `browser` leg (a hand-written flow or a compiled workflow). A route marked `prefer: "browser"` answers from its browser leg even with a token: X bills every API read, so its profile, posts, one-post and search reads run on the signed-in page (`src/browser/flows/x-read.ts`, proven 2026-09-29 as x@wren) in v2's shapes, `since_id` as the cursor. Setup steps make tokens the same way (`src/sites/types.ts:45-100`). `auth: {open: true}` is a keyless site (`web`: search and read, `src/sites/web.ts`), every api leg runs.

## Shape

- `SiteApi { site, origin, auth: {token}|{oauth}|{open}, routes, setup, purpose?, probe?, caps?, pace? }` — `src/sites/types.ts:154-178`; `caps` = most a route's `meter` may use per account per day (LinkedIn: profile 80, search 25, company 40; X: profile 150, posts 100, search 50); `pace` = gap between one account's browser calls (X 5s + up to 10s, LinkedIn 10s + up to 20s)
- `SiteRoute { method, path ({param}), request (zod), api?, browser?, irreversible?, spends?, meter?, prefer?, summary }` — `:45-75`; `ApiLeg { token, http, env }` — `:19-24`; `Leg = {flow}|{workflow}`, `BrowserLeg` — `:31-43`
- `SetupStep { name, makes, needs?, how: Leg+input | {oauth}, summary, purpose? }` — `:85-100`; `OAuthSpec` — `:102-152`; `SiteError { status, retryAfter? }` — `:180-190`
- Per-site files: `src/sites/<site>.ts`; `route()` erases types — `:193`

## Connected to

- **owns:** routes, setup steps, its OAuth spec
- **owned-by:** [[site-facade]]
- **joins:** [[token]] (`auth`, `makes`), [[flow]] / [[compiled-workflow]] (browser legs), [[ability]] (`kind: "site"`), [[need]] (`siteNeeds`), [[account]] (`purpose`), [[spend-policy]] (`spends`)
- **looks-like-but-is-not:** [[site-login]]; `Site` the profile name

## If you change this

- **Hits:** `src/sites/facade.ts`, `src/sites/renew.ts` (`keptBy`), `src/sites/wire.ts`, `src/app/needs.ts:59-170`, `src/do/catalog.ts:83`, `src/app/cli-site.ts`, UI `/api/sites` (`src/ui/api.ts:370-419`), wren's channel packages (they call these routes by path).
- **Does not hit:** sign-ins; the run object.

## Surfaces

| Surface | Role |
|---|---|
| `autobrowse site call/setup/check` | calls |
| wren (Restate `sites`) | calls |

## See

- Source: `src/sites/types.ts`, `src/sites/index.ts`
- Design: `designs/2026-09-21-site-apis.md`
