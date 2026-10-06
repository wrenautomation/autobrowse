---
type: object
cluster: browser
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/browser/session.ts
---

# Session

One open browser context with a page, on a persistent profile named by the site: `Session` from `openSession` in `src/browser/session.ts`.

## Why this shape

A profile per site name keeps sign-ins between runs. Three tiers say where the browser is (`Tier`, `src/browser/session.ts:77`): launched here, Browserbase, or a CDP endpoint (a Chrome or Electron app). A shared context (the person's own browser) gets nothing context-wide (`:119-124`).

## Shape

- `Session { context, page, shared?, passkeys, close }` — `src/browser/session.ts:119-130`
- `BrowserOptions` — `:79`; `NeedsHuman` (a person is needed; artifacts set by the runner) — `:30-37`; `Artifacts` — `:39-49`
- Egress (opt-in, `EGRESS_SITES=web:mobile,linkedin@research:isp` + `EGRESS_<NAME>` proxy URLs): a local launch for a listed site (`x`: every x profile) or profile goes out through its named exit; unlisted or `desk` = this machine's line — `src/browser/egress.ts` (designs/2026-10-04-egress.md). An exit may rotate (`EGRESS_<NAME>_ROTATE`, a change-IP URL, `_GAP` seconds apart): `Session.newIp` / `FlowPage.newIp`, used by Google's `/sorry` before the captcha. A rotating exit never serves a site in `SITE_LOGINS` (startup refuses). A proxied launch blocks WebRTC's unproxied UDP (it would show the page the real IP) and says `EGRESS_<NAME>_TZ`; others say `BROWSER_TIMEZONE` (Chrome reads `TZ`). `autobrowse doctor` prints the mapping, no URLs
- How real it looks, measured: `autobrowse fingerprint [profile] [--box]` (the `fingerprint/check` flow, `src/browser/flows/fingerprint.ts`) reads the IP's network and zone and the page (UA, WebGL, codecs, WebRTC) and lists the tells
- `Wall` and `looksLikeWall` (login or captcha) — `:364-376`
- Kept warm between calls by `SessionPark` (`src/browser/park.ts:25`), closed on the worker's SIGTERM/SIGINT (`buildApp`, `src/app/services.ts`); orphans reaped (`src/browser/reap.ts`, `browserRoots` shared with `browsers`)
- A local launch first checks the profile's `SingletonLock` (`assertProfileFree`, `src/browser/browsers.ts`): a live browser holding it fails with `profile <name> is open in pid <pid> (<owner>)`; a dead pid or another host's lock is left to Chrome
- `autobrowse browsers [--json]` / `browsers stop <port|pid|profile>`: every root browser on our profiles with owner (`desk`, `worker`, `explore:<port>`, `agent:<port>`, `teach:<port>`, `cli`, `orphan`, `other`), age and tree RSS, plus explore servers; `warnings` (thresholds at the top of `src/browser/browsers.ts`) also feed `doctor` (designs/2026-10-06-browser-lifecycle.md)
- Page calls: `NetLog.of(context)` (`src/browser/network.ts`) logs XHR, fetch and page loads per context, redacted before kept (secret headers dropped, secret keys and token shapes `<redacted>`); a personal profile (`x`, `linkedin`, `google` bare, `NETWORK_PERSONAL`) keeps method, path, status only. The runner exposes it as `FlowPage.network` (designs/2026-10-06-network-capture.md)
- Fingerprint: `src/browser/identity.ts:16-136` (UA, geometry); virtual authenticator: `src/browser/webauthn.ts:32-57`
- Own browser (opt-in, `OWN_BROWSER_SITES`): `src/browser/own.ts:24-94`

## Connected to

- **owns:** passkeys (`Passkeys`, `src/browser/webauthn.ts:32`)
- **owned-by:** [[flow]] (the runner opens one per flow), the explore session
- **joins:** [[settings]] (`browserOptions`, `src/app/services.ts:265`), [[state-files]] (`profiles/`)
- **looks-like-but-is-not:** [[agent-session]]; `Identity` in `src/auth/identities.ts`

## If you change this

- **Hits:** `src/browser/flow.ts:384` (`flowRunner`), `src/explore/server.ts:500`, `src/browser/park.ts`, `src/browser/reap.ts`, `src/browser/browsers.ts`, `src/browser/own.ts`, `src/app/services.ts:211-301`.
- **Does not hit:** flows themselves (they see `FlowPage`), the agent's step loop.

## Surfaces

| Surface | Role |
|---|---|
| runner, explore | open, close |
| `autobrowse reap` | closes orphans |
| `autobrowse browsers`, `doctor` | list, warn, stop one |

## See

- Source: `src/browser/session.ts`
