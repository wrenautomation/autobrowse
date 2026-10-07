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

One place picks the account, mints the bearer, matches the path, books the account's pace slot, takes its daily cap, asks the spend policy, and falls to the browser leg. A route with `prefer: "browser"` never looks up a token, so a read the API bills (X) always goes through the signed-in page. `prefer` may be a function of the parsed request (`prefersBrowser`, `src/sites/types.ts`): LinkedIn `POST /rest/posts` with `author: urn:li:organization:<id>` goes to the browser leg even with a token, since Wren's token holds `w_member_social` only (2026-10-07, `test/linkedin-create-post.test.ts`). A route listing has no request, so it shows `api` for such a route. `pace` spaces one account's browser-leg calls (gap + random jitter, per site and account, in `caps.json` `next`); the call sleeps until its slot, and a slot more than 2 minutes out is a 429 whose message ends `retry after Ns` (wren parses that phrase; also `retryAfter` in the JSON and a `Retry-After` header). A named account (`linkedin@research`) resolves to its credential's address (`usernameOf`) and never falls back; over a cap the call is refused 429 with `retryAfter` (seconds to UTC midnight), never queued; a cap of 0 says the reads are off. Every metered call is noted (caller, route template, outcome `ok`/`failed`/`capped`/`paced`, Restate invocation) to `caps-calls/<day>.jsonl` beside the caps file, kept two weeks: the answer to who spent a bucket. A metered read that fails for any other reason is a terminal 502: the slot is spent, and a durable retry would spend one per try (six failing reads ate 40, 2026-10-01). The caller names itself with the request's `caller` or an `x-caller` header; `sites/caps` and `site caps [--box]` read it back. The Restate face (`sitesService`) means an orchestrator on the same Restate queues a call while the box is down and a write runs once.

## Shape

- `SiteFacade { list, status, call(site, method, path, input, account?, from?), caps(day?, site?), setup(site, step, account?, profile?, input?), renew? }` — `src/sites/facade.ts:136-166`; `CallFrom { caller?, invocation? }`, `CapsReport { day, used, calls }` — `:124-134`
- `SiteFacadeDeps { http, env, sink, runner, flow, compiled?, oauthPort?, profileFor?, providerOf?, accountFor?, approve?, caps?, sleep?, accountOf? }` — `:33-82`; `matchPath` — `:203`; `checkSite` — `:173`
- `SiteParts` (what `sitesFor` needs, including `reload` for tokens minted elsewhere) — `src/sites/wire.ts:30-69`; `usernameOf` — `:137-145`
- `DailyCaps { take, slot, today, note, calls }`, `Pace { gapMs, jitterMs?, maxWaitMs? }`, `fileCaps` (`CAPS_FILE`, `/data/caps.json` on the box), `memoryCaps` — `src/sites/caps.ts:52-67`; `MeteredCall { at, site, account, route, use, caller, invocation?, outcome, bucket? }` — `:70-84`; the day files — `:156-189`
- Restate: `SITES_SERVICE = "sites"`, `DESK_SERVICE = "desk"` (the Mac), `sitesService(facade, name)` with `call`, `status`, `caps`, `renew`, `setup` — `src/sites/service.ts:16-122`
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
