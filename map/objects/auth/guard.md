---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/auth/guard.ts
---

# Guard

A secret bound to the hosts it may be typed on: `boundPage` / `guardedPage` in `src/auth/guard.ts`; a miss is `SecretLeak`.

## Why this shape

A fill whose value is a secret is checked against the page's host before anything is typed, recorded either way, refused when the host is wrong. The binding wraps `FlowPage`, so sign-ins, compiled workflows and explore `place` all get it without knowing.

## Shape

- `SecretLeak`, `hostUnder`, `registrable`, `urlWithoutQuery` — `src/auth/guard.ts:12-44`
- `GuardOptions { name, cred, domains, site, by, audit?, fallback? }` — `:45-57`; `BindOptions { secretOf, allow, site, by, audit }` — `:64-75`
- `boundPage(fp, b)` — `:88`; `guardedPage(fp, g)` — `:127`; `boundRunner(runner, o)` — `:160`
- Domains come from the login spec (`origins`, `home`) via `passwordDomains` — `src/auth/login.ts:392`

## Connected to

- **owned-by:** `loginProvider`; `compiledDeps` (`src/workflows/compiled-deps.ts:31-37`); the explore server (`secretHosts`, `src/explore/server.ts:355`)
- **joins:** [[credential]] (audit), [[flow]], [[site-login]]

## If you change this

- **Hits:** `src/auth/login.ts`, `src/workflows/compiled-deps.ts`, `src/explore/server.ts`, `src/app/cli-record.ts`, `src/app/services.ts`.
- **Does not hit:** site API tokens (never typed), the wallet gate (`src/gates/payment.ts`).

## Surfaces

| Surface | Role |
|---|---|
| everything that types a secret | passes through |
| `autobrowse ledger` / `/api/ledger` | reads the audit |

## See

- Source: `src/auth/guard.ts`
