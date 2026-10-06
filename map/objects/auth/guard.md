---
type: object
cluster: auth
universe: live
status: verified
verified: 2026-10-06 @ b9fc8f3
entity: src/auth/guard.ts
---

# Guard

A secret bound to the hosts it may be typed on: `boundPage` / `guardedPage` in `src/auth/guard.ts`; a miss is `SecretLeak`.

## Why this shape

A fill whose value is a secret is checked against the page's host before anything is typed, recorded either way, refused when the host is wrong. The binding wraps `FlowPage`, so sign-ins, compiled workflows and explore `place` all get it without knowing.

## Shape

- `SecretLeak`, `hostUnder`, `registrable`, `hostNamed`, `urlWithoutQuery` — `src/auth/guard.ts:13-57`. `registrable` is tldts `getDomain` with private suffixes (`evil.github.io` stays itself, `foo.co.uk` is not `co.uk`); `hostNamed` is the site-word check (registrable's first label), used by the no-domains fallback, `siteAllowsHost` and mod logins
- `GuardOptions { name, cred, domains, site, by, audit?, fallback? }` — `:59-71`; `BindOptions { secretOf, allow, site, by, audit }` — `:78-86`
- `boundPage(fp, b)` — `:102`; `guardedPage(fp, g)` — `:141`; `boundRunner(runner, o)` — `:174`
- Domains come from the login spec (`origins`, `home`) via `passwordDomains` — `src/auth/login.ts:533`

## Connected to

- **owned-by:** `loginProvider`; `compiledDeps` (`src/workflows/compiled-deps.ts:31-37`); the explore server (`secretHosts`, `src/explore/server.ts:359`)
- **joins:** [[credential]] (audit), [[flow]], [[site-login]]

## If you change this

- **Hits:** `src/auth/login.ts`, `src/workflows/compiled-deps.ts`, `src/explore/server.ts`, `src/app/cli-record.ts`, `src/app/services.ts`.
- **Hits too:** `src/mods/login.ts` (`hostNamed`), `src/gates/payment.ts` (`paymentFlowOf` is `registrable`).
- **Does not hit:** site API tokens (never typed).

## Surfaces

| Surface | Role |
|---|---|
| everything that types a secret | passes through |
| `autobrowse ledger` / `/api/ledger` | reads the audit |

## See

- Source: `src/auth/guard.ts`
