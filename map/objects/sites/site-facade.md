---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-10-18 @ 2eccaf2+
entity: src/sites/facade.ts
---

# Site facade

The one instance that runs a site call, a setup step or a renewal, shared by the CLI, the HTTP API and the Restate service `sites`: `SiteFacade` from `siteFacade` in `src/sites/facade.ts`, wired by `sitesFor` in `src/sites/wire.ts`.

## Why this shape

One place picks the account, mints the bearer, matches the path, books the account's pace slot, takes its daily cap, asks the spend policy, and falls to the browser leg. A route with `prefer: "browser"` never looks up a token, so a read the API bills (X) always goes through the signed-in page. Grants (2026-10-13): a route's `needs` (a list, or a function of the parsed request, `needsOf` in `src/sites/types.ts`) names the scopes or products its API leg needs. The token's grants are the scopes its consent got (`<SITE>_SCOPES[__ACCOUNT]`, written at consent from the answer's `scope`, else the spec's) plus `<SITE>_GRANTS`, set by hand when a review or product passes. A lacking grant runs the route as if no token were held: the browser leg, else a 501 `waiting on <grant>`; the route listing shows the same. So a fallback leg and the API share one request and answer shape, and a passed review is one env value, no caller change. LinkedIn Page acts need `w_organization_social`/`r_organization_social` (Community Management, in review since 2026-10-09), a member's own posts `r_member_social`; X page replies `X_GRANTS=replies`; Meta Page comment replies `pages_manage_engagement`, Page DMs `META_GRANTS=messaging` (`test/linkedin-create-post.test.ts`). `pace` spaces one account's browser-leg calls (gap + random jitter, per site and account, in `caps.json` `next`); the call sleeps until its slot, and a slot more than 2 minutes out is a 429 whose message ends `retry after Ns` (wren parses that phrase; also `retryAfter` in the JSON and a `Retry-After` header). A named account (`linkedin@research`) resolves to its credential's address (`usernameOf`) and never falls back; over a cap the call is refused 429 with `retryAfter` (seconds to UTC midnight), never queued; a cap of 0 says the reads are off. Every metered call is noted (caller, route template, outcome `ok`/`failed`/`capped`/`paced`, Restate invocation) to `caps-calls/<day>.jsonl` beside the caps file, kept two weeks: the answer to who spent a bucket. Uses and tries (2026-10-29, `designs/2026-10-29-cap-tries.md`): the cap holds uses (calls that worked); `tried` (uses plus failures that reached the site) holds the cap plus `retryBuffer` (default 0.25 acts, 0.5 reads, at least 1). The leg's `Reach` (`src/browser/attempt.ts`: a load, an act, any browser response, an API request) settles the slot: ok is a use, an `already()` answer a try, a reached failure a try and a terminal 502 ("failed after spending a try"; six failing reads ate 40, 2026-10-01), an unreached one spends nothing and keeps its own error. `MeteredCall.spent` says which. The caller names itself with the request's `caller` or an `x-caller` header; `sites/caps` and `site caps [--box]` read it back. Limits (2026-10-26): `limits.json` (`LIMITS_FILE`, `src/sites/limits.ts`) sets a site's `caps`, an account's caps and the `pace` over the code's defaults, bucket by bucket (`effective`); the facade reads it each call, so an edit holds from the next one; a bad file keeps the last good one. `autobrowse limits [site]` shows each value, `*` where the file sets it, and today's use; `limits set|pace|unset` edit it. Paid keys' `capsPerKey` stay in code. The Restate face (`sitesService`) means an orchestrator on the same Restate queues a call while the box is down and a write runs once.

## Shape

- `SiteFacade { list, status, call(site, method, path, input, account?, from?), sendSpec?(site, method, path), caps(day?, site?), setup(site, step, account?, profile?, input?), renew?({dry?, names?}), revoke?(site, account?), refused?(), claimRefused?() }` — `src/sites/facade.ts:212`; `CallFrom { caller?, invocation?, arm?, armId? }`, `Armed`, `CapsReport { day, used, tried, calls }` — `:157-200`
- Arming (designs/2026-10-12-watchers-and-arming.md): `call(..., {arm: true})` runs a browser leg's `prepare` in a tab of its own (`FlowRunner.tab`) and answers `{armed: id, until}` (`armLeg`, `src/sites/facade.ts:446`); the next call on the same path and target (typed words left out, `armKey`), or `{armId}`, runs the leg in that tab (`takeArm`), so `run`'s opening finds the page open. An API leg, a spend, a GET, an upload or a flow without `prepare`: `{armed: null}`. `ARM_MS` 20 min, 3 per browser (`:173`). Restate `sites/arm`, `armId` on `sites/call` (`src/sites/service.ts:600`)
- `SiteFacadeDeps { http, env, sink, runner, flow, render?, compiled?, oauthPort?, profileFor?, providerOf?, accountFor?, approve?, caps?, sleep?, accountOf? }` — `:59`; `matchPath` — `:296`; `checkSite` — `:267`
- `SiteParts` (what `sitesFor` needs, including `reload` for tokens minted elsewhere) — `src/sites/wire.ts:30-69`; `usernameOf` — `:137-145`
- `DailyCaps { take(…, buffer?), giveBack(…, reached?), slot, today, tried, note, calls }`, `RETRY_BUFFER`, `Pace { gapMs, jitterMs?, maxWaitMs? }`, `fileCaps` (`CAPS_FILE`, `/data/caps.json` on the box), `memoryCaps` — `src/sites/caps.ts:52-67`; `MeteredCall { at, site, account, route, use, caller, invocation?, outcome, bucket?, spent? }` — `:70-84`; the day files — `:156-189`
- Restate: `SITES_SERVICE = "sites"`, `DESK_SERVICE = "desk"` (the Mac), `sitesService(facade, name, calls?, watchers?, { wait?, journal?, verifyPausesMs? })` with `call`, `verdict`, `status`, `caps`, `renew` (`names` re-makes refused ones now), `revoke`, `setup` — `src/sites/service.ts:42-47,263`; a 409 refusal on `call` queues `renew {names}` once per incident (`queueRemake`, `src/sites/service.ts:100`)
- Keyed writes (designs/2026-10-16-send-verdicts.md): `call` with `sendKey` on a non-GET answers a `SendVerdict` (`src/sites/verdict.ts`), never an error for an unclear end. `sendSpec(site, method, path)` gives the service the matched route's `irreversible`, `verify`, `sentAs` and `parse` (`SendSpec`, `src/sites/facade.ts:203`; optional, a stand-in without it reads as "no verify read"). Under a key `currentCall()` is `send <key>`, so the API leg's `started` guard and the browser leg's `done` guard span every invocation of that key. The leg code is as before. Without a key a write answers today's words (`sentWords`)
- The send journal: `SendJournal { get, start, submitted, settle, tried, forget, live, enter, leave }`, one JSON file per key (`sha256(key).json`, mode 0600, tmp + rename, 30 days) in `<artifactsDir>/sends/` on `sites` and `desk` each — `src/sites/send-journal.ts:28-70,150`, wired by `sendJournalFor` (`src/app/services-state.ts:358`); `markSubmitted` calls `CallTry.onSubmit` first, so `submitted` is on disk before the act (`src/browser/attempt.ts:35,57`). A final verdict stands; `unknown` is replaced by a later verdict
- `render` (2026-10-18, `src/sites/facade.ts:109`) is a stealth-browser page fetch, `renderer` in `src/browser/render.ts`, handed to every api leg as `ApiLeg.render`; only `web GET /fetch` uses it. `sitesFor` in the CLI app (`src/app/backend.ts`) gets none, so there the ladder stops at the TLS rung
- Paths are interpolated by the caller; a template path plus a param in the input is HTTP 400
- Access codes (10-29, `designs/2026-10-28-signed-in-reads.md`): `SiteError.code` is one of `ACCESS_CODES` (`src/browser/session.ts`); `accessError` (`src/sites/facade.ts`) turns a GET browser leg's wall (`NeedsHuman.wall`) or `AccessRefused` into a coded, terminal SiteError. HTTP answers `code`; Restate answers `metadata.code`. birdwatch's ladder clients (`@wrenautomation/read`) read both

## Connected to

- **owns:** the call path
- **owned-by:** [[app]] (`App.sites`), [[backend]] (`sites`)
- **joins:** [[site-api]], [[token]], [[account]], [[flow]] (browser legs), [[compiled-workflow]] (`compiled.run`), [[approval]] (`approve`), [[ability]] (site abilities call it)
- **looks-like-but-is-not:** [[browser-service]]

## If you change this

- **Hits:** `src/sites/wire.ts`, `src/sites/service.ts`, `src/sites/send-journal.ts`, `src/app/cli-site.ts`, `src/ui/api.ts:75` (`siteError`: status, `Retry-After`), `src/ui/api.ts:466-520`, `src/do/doer.ts` (`callSite`), `src/app/needs.ts`, wren's `Content` service and channel packages (Restate `sites/call`, `sites/verdict`, `sites/status`, `sites/setup`, `sites/caps`).
- **Does not hit:** sign-ins; the run object.

## Surfaces

| Surface | Role |
|---|---|
| CLI `site`, UI `/api/sites`, Restate `sites` | call |
| wren (outside the tree) | calls over the shared Restate ingress |

## See

- Source: `src/sites/facade.ts`, `src/sites/wire.ts`, `src/sites/service.ts`, `src/sites/send-journal.ts`, `src/sites/verdict.ts`
