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

A profile per site name keeps sign-ins between runs. Three tiers say where the browser is (`Tier`, `src/browser/session.ts:76`): launched here, Browserbase, or a CDP endpoint (a Chrome or Electron app). A shared context (the person's own browser) gets nothing context-wide (`:107-117`).

## Shape

- `Session { context, page, shared?, passkeys, close }` — `src/browser/session.ts:107-118`
- `BrowserOptions` — `:78`; `NeedsHuman` (a person is needed; artifacts set by the runner) — `:29-36`; `Artifacts` — `:38-48`
- `Wall` and `looksLikeWall` (login or captcha) — `:334-349`
- Kept warm between calls by `SessionPark` (`src/browser/park.ts:25`); orphans reaped (`src/browser/reap.ts:25-79`)
- Fingerprint: `src/browser/identity.ts:16-136` (UA, geometry); virtual authenticator: `src/browser/webauthn.ts:32-57`
- Own browser (opt-in, `OWN_BROWSER_SITES`): `src/browser/own.ts:24-94`

## Connected to

- **owns:** passkeys (`Passkeys`, `src/browser/webauthn.ts:32`)
- **owned-by:** [[flow]] (the runner opens one per flow), the explore session
- **joins:** [[settings]] (`browserOptions`, `src/app/services.ts:243`), [[state-files]] (`profiles/`)
- **looks-like-but-is-not:** [[agent-session]]; `Identity` in `src/auth/identities.ts`

## If you change this

- **Hits:** `src/browser/flow.ts:382` (`flowRunner`), `src/explore/server.ts:434`, `src/browser/park.ts`, `src/browser/reap.ts`, `src/browser/own.ts`, `src/app/services.ts:195-276`.
- **Does not hit:** flows themselves (they see `FlowPage`), the agent's step loop.

## Surfaces

| Surface | Role |
|---|---|
| runner, explore | open, close |
| `autobrowse reap` | closes orphans |

## See

- Source: `src/browser/session.ts`
