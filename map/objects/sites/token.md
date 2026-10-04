---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-09-28 @ 70aefc3
entity: src/sites/oauth.ts
---

# Token

A site API key or OAuth token kept in the env store under a name, per account: minted by `accessTokens` and `runConsent` in `src/sites/oauth.ts`, renewed by `src/sites/renew.ts`, kept through the `SecretSink` (`src/deps/sink.ts`).

## Why this shape

Access tokens are minted on demand from the refresh token and cached until they expire; a rolled refresh token is kept back under the same name. A token minted on the laptop is seen on the box by a one-time reload on a miss, because every SSM read is a KMS decrypt (`src/sites/wire.ts:54-69`).

## Shape

- `accountEnv(name, account)` = the per-account name — `src/sites/oauth.ts:80`; `accessTokens(http, env, now, keep)` — `:102-135`; `runConsent` — `:203`; `pkcePair`, `codeFrom` — `:74,148`; `WEB_REDIRECT` (the https redirect Meta, Instagram and TikTok register) — `:71`
- Renewal: `RENEW_WITHIN_MS` 14 days, `Renewal`, `RenewalPlan`, `renewals`, `renewDue`, `nextLapse` — `src/sites/renew.ts:18-144`
- Store: `SecretSink.put(name, value, o)` — `src/deps/sink.ts:9-12`; `envStoreFor` / `sinkFor` (SSM `/autobrowse/config` via credvault `EnvStore`, `.env` locally) — `src/app/services.ts:958,769`; `autobrowse env` (`src/app/cli-env.ts`)
- Loopback redirect `OAUTH_PORT` 9400; a `keep` op in a recording lands here too

## Connected to

- **owned-by:** the env store (credvault); [[site-api]] (`auth`, `makes`)
- **joins:** [[site-facade]], [[account]] (names carry the account), [[need]] (`kept` with expiry), [[outline]] (`keep` ops), [[recording]]
- **looks-like-but-is-not:** [[credential]] (a sign-in), an [[access-key]] (autobrowse's own API key)

## If you change this

- **Hits:** `src/sites/facade.ts`, `src/sites/renew.ts`, `src/sites/wire.ts`, `src/app/cli-env.ts`, `src/app/needs.ts`, wren's `TokenRenewal` and its reads of `/autobrowse/config` (outside the tree).
- **Does not hit:** the vault of sign-ins; the wallet.

## Surfaces

| Surface | Role |
|---|---|
| `site setup`, `site renew`, `autobrowse env` | write |
| API legs, wren | read |

## See

- Source: `src/sites/oauth.ts`, `src/sites/renew.ts`
- Design: `designs/2026-09-21-site-apis.md`
