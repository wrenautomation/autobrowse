---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-10-16 @ refused-tokens
entity: src/sites/oauth.ts
---

# Token

A site API key or OAuth token kept in the env store under a name, per account: minted by `accessTokens` and `runConsent` in `src/sites/oauth.ts`, renewed by `src/sites/renew.ts`, refused ones kept by `src/sites/refused.ts`, kept through the `SecretSink` (`src/deps/sink.ts`).

## Why this shape

Access tokens are minted on demand from the refresh token and cached until they expire; a rolled refresh token is kept back under the same name. A refresh token the platform refused is not sent again for 5 minutes (by name and value, so a re-consented one is tried at once). A token minted on the laptop is seen on the box by a one-time reload on a miss, because every SSM read is a KMS decrypt (`src/sites/wire.ts:224-260`).

Refused tokens (designs/2026-10-16-refused-tokens.md): a refusal (invalid_grant, revoked, a 401 on the who-am-I probe) is kept by name, site, account, since when and the site's words, in `refused-tokens.json` in the state dir. The first of an incident is one ops-lane line; later calls add nothing. A refused name is due at once: the desk queues `renew {names}` for it (one-way, keyed by name and since), and the daily renew probes every site first and makes it again too. One try a day, marked before the setup runs, so a hung consent page costs a day, not a loop. Two failed days and renew stops with one ping saying the setup a person runs; a setup that makes it, or a call that works, ends the incident. `site revoke` is the only way our code ends a grant, and it marks every name the grant covered, so their re-make is queued in the same call.

## Shape

- `accountEnv(name, account)` = the per-account name — `src/sites/oauth.ts:80`; `accessTokens(http, env, now, keep)` — `:102-135`; `runConsent` — `:203`; `pkcePair`, `codeFrom` — `:74,148`; `WEB_REDIRECT` (the https redirect Meta and Instagram register; TikTok registers wren's portal callback, `TIKTOK_REDIRECT` in `src/sites/tiktok.ts`) — `:71`
- Renewal: `RENEW_WITHIN_MS` 14 days, `Renewal`, `RenewalPlan`, `renewals` (lapsing + refused), `renewDue`, `renewWording`, `nextLapse` — `src/sites/renew.ts:21-188`
- Refused: `TokenRefused { token, why, site, account }` — `src/sites/oauth.ts:102`; `revokeGrant` — `src/sites/oauth.ts:191`; `RefusedToken`, `RefusedTokens { list, refuse, claim, start, end, stale, clear }`, `GIVE_UP_DAYS` 2, `dueToday`, `fileRefusedTokens`, `refusedLine` — `src/sites/refused.ts:13-180`; kept and said in `sitesFor` (`record`, `withRenew`, `revoke`) — `src/sites/wire.ts:232-408`; queued by `sitesService` (`queueRemake`, `revoke`) — `src/sites/service.ts:90,355`; notices via `opsLane` — `src/app/ops.ts`
- Store: `SecretSink.put(name, value, o)` — `src/deps/sink.ts:9-12`; `envStoreFor` / `sinkFor` (SSM `/autobrowse/config` via credvault `EnvStore`, `.env` locally) — `src/app/services.ts:958,769`; `autobrowse env` (`src/app/cli-env.ts`)
- Loopback redirect `OAUTH_PORT` 9400; a `keep` op in a recording lands here too

## Connected to

- **owned-by:** the env store (credvault); [[site-api]] (`auth`, `makes`)
- **joins:** [[site-facade]], [[account]] (names carry the account), [[need]] (`kept` with expiry), [[outline]] (`keep` ops), [[recording]]
- **looks-like-but-is-not:** [[credential]] (a sign-in), an [[access-key]] (autobrowse's own API key)

## If you change this

- **Hits:** `src/sites/facade.ts`, `src/sites/renew.ts`, `src/sites/refused.ts`, `src/sites/service.ts`, `src/sites/wire.ts`, `src/app/cli-env.ts`, `src/app/needs.ts`, wren's `TokenRenewal` and its reads of `/autobrowse/config` (outside the tree).
- **Does not hit:** the vault of sign-ins; the wallet.

## Surfaces

| Surface | Role |
|---|---|
| `site setup`, `site renew`, `site revoke`, `autobrowse env` | write |
| `site status`, `site check`, `site list` (refused, since when) | read |
| API legs, wren | read |

## See

- Source: `src/sites/oauth.ts`, `src/sites/renew.ts`, `src/sites/refused.ts`
- Design: `designs/2026-09-21-site-apis.md`, `designs/2026-10-16-refused-tokens.md`
- Tests: `test/refused-tokens.test.ts`
