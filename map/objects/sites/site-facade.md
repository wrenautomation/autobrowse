---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-10-07 @ 9726bda+
entity: src/sites/facade.ts
---

# Site facade

The one instance that runs a site call, a setup step or a renewal, shared by the CLI, the HTTP API and the Restate service `sites`: `SiteFacade` from `siteFacade` in `src/sites/facade.ts`, wired by `sitesFor` in `src/sites/wire.ts`.

## Why this shape

One place picks the account, mints the bearer, matches the path, books the account's pace slot, takes its daily cap, asks the spend policy, and falls to the browser leg. A route with `prefer: "browser"` never looks up a token, so a read the API bills (X) always goes through the signed-in page. Grants (2026-10-13): a route's `needs` (a list, or a function of the parsed request, `needsOf` in `src/sites/types.ts`) names the scopes or products its API leg needs. The token's grants are the scopes its consent got (`<SITE>_SCOPES[__ACCOUNT]`, written at consent from the answer's `scope`, else the spec's) plus `<SITE>_GRANTS`, set by hand when a review or product passes. A lacking grant runs the route as if no token were held: the browser leg, else a 501 `waiting on <grant>`; the route listing shows the same. So a fallback leg and the API share one request and answer shape, and a passed review is one env value, no caller change. LinkedIn Page acts need `w_organization_social`/`r_organization_social` (Community Management, in review since 2026-10-09), a member's own posts `r_member_social`; X page replies `X_GRANTS=replies`; Meta Page comment replies `pages_manage_engagement`, Page DMs `META_GRANTS=messaging` (`test/linkedin-create-post.test.ts`). `pace` spaces one account's browser-leg calls (gap + random jitter, per site and account, in `caps.json` `next`); the call sleeps until its slot, and a slot more than 2 minutes out is a 429 whose message ends `retry after Ns` (wren parses that phrase; also `retryAfter` in the JSON and a `Retry-After` header). A named account (`linkedin@research`) resolves to its credential's address (`usernameOf`) and never falls back; over a cap the call is refused 429 with `retryAfter` (seconds to UTC midnight), never queued; a cap of 0 says the reads are off. Every metered call is noted (caller, route template, outcome `ok`/`failed`/`capped`/`paced`, Restate invocation) to `caps-calls/<day>.jsonl` beside the caps file, kept two weeks: the answer to who spent a bucket. A metered read that fails for any other reason is a terminal 502: the slot is spent, and a durable retry would spend one per try (six failing reads ate 40, 2026-10-01). The caller names itself with the request's `caller` or an `x-caller` header; `sites/caps` and `site caps [--box]` read it back. The Restate face (`sitesService`) means an orchestrator on the same Restate queues a call while the box is down and a write runs once.

## Shape

- `SiteFacade { list, status, call(site, method, path, input, account?, from?), caps(day?, site?), setup(site, step, account?, profile?, input?), renew?({dry?, names?}), revoke?(site, account?), refused?(), claimRefused?() }` — `src/sites/facade.ts:174-204`; `CallFrom { caller?, invocation?, arm?, armId? }`, `Armed`, `CapsReport { day, used, calls }` — `:137-172`
- Arming (designs/2026-10-12-watchers-and-arming.md): `call(..., {arm: true})` runs a browser leg's `prepare` in a tab of its own (`FlowRunner.tab`) and answers `{armed: id, until}` (`armLeg`, `src/sites/facade.ts:345`); the next call on the same path and target (typed words left out, `armKey`), or `{armId}`, runs the leg in that tab (`takeArm`), so `run`'s opening finds the page open. An API leg, a spend, a GET, an upload or a flow without `prepare`: `{armed: null}`. `ARM_MS` 20 min, 3 per browser (`:153`). Restate `sites/arm`, `armId` on `sites/call` (`src/sites/service.ts:200`)
- `SiteFacadeDeps { http, env, sink, runner, flow, compiled?, oauthPort?, profileFor?, providerOf?, accountFor?, approve?, caps?, sleep?, accountOf? }` — `:45-98`; `matchPath` — `:244`; `checkSite` — `:215`
- `SiteParts` (what `sitesFor` needs, including `reload` for tokens minted elsewhere) — `src/sites/wire.ts:30-69`; `usernameOf` — `:137-145`
- `DailyCaps { take, slot, today, note, calls }`, `Pace { gapMs, jitterMs?, maxWaitMs? }`, `fileCaps` (`CAPS_FILE`, `/data/caps.json` on the box), `memoryCaps` — `src/sites/caps.ts:52-67`; `MeteredCall { at, site, account, route, use, caller, invocation?, outcome, bucket? }` — `:70-84`; the day files — `:156-189`
- Restate: `SITES_SERVICE = "sites"`, `DESK_SERVICE = "desk"` (the Mac), `sitesService(facade, name)` with `call`, `status`, `caps`, `renew` (`names` re-makes refused ones now), `revoke`, `setup` — `src/sites/service.ts:16-122`; a 409 refusal on `call` queues `renew {names}` once per incident (`queueRemake`, `src/sites/service.ts:90`)
- Paths are interpolated by the caller; a template path plus a param in the input is HTTP 400

## Connected to

- **owns:** the call path
- **owned-by:** [[app]] (`App.sites`), [[backend]] (`sites`)
- **joins:** [[site-api]], [[token]], [[account]], [[flow]] (browser legs), [[compiled-workflow]] (`compiled.run`), [[approval]] (`approve`), [[ability]] (site abilities call it)
- **looks-like-but-is-not:** [[browser-service]]

## If you change this

- **Hits:** `src/sites/wire.ts`, `src/sites/service.ts`, `src/app/cli-site.ts`, `src/ui/api.ts:75` (`siteError`: status, `Retry-After`), `src/ui/api.ts:466-520`, `src/do/doer.ts` (`callSite`), `src/app/needs.ts`, wren's `Content` service and channel packages (Restate `sites/call`, `sites/status`, `sites/setup`, `sites/caps`).
- **Does not hit:** sign-ins; the run object.

## Surfaces

| Surface | Role |
|---|---|
| CLI `site`, UI `/api/sites`, Restate `sites` | call |
| wren (outside the tree) | calls over the shared Restate ingress |

## See

- Source: `src/sites/facade.ts`, `src/sites/wire.ts`, `src/sites/service.ts`
