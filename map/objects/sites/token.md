---
type: object
cluster: sites
universe: live
status: verified
verified: 2026-10-19 @ 59847e7
entity: src/sites/oauth.ts
---

# Token

A site API key or OAuth token kept in the env store under a name, per account: minted by `accessTokens` and `runConsent` in `src/sites/oauth.ts`, renewed by `src/sites/renew.ts`, refused ones kept by `src/sites/refused.ts`, kept through the `SecretSink` (`src/deps/sink.ts`). The pure part of sign-in (PKCE, provider URLs) lives in [[oauth-piece]] (`src/oauth/`): `pkcePair` is built on its `pkceVerifier`/`pkceChallenge`, and each site's `OAuthSpec` takes `authorizeUrl`/`tokenUrl` from its `OAUTH_PROVIDERS` table.

## Why this shape

Access tokens are minted on demand from the refresh token and cached until they expire; a rolled refresh token is kept back under the same name, held in memory before the store write. One mint per refresh token at a time in a process, and every process on the machine shares its mints through `access-tokens.json` in the state dir (`fileMintedTokens`, owner-only): X rolls its token on each mint, and a mint whose answer timed out lost one on 10-16, after ~30 mints in 8 hours. A refresh token the platform refused is not sent again for 5 minutes (by name and value, so a re-consented one is tried at once). A token minted on the laptop is seen on the box by a one-time reload on a miss, because every SSM read is a KMS decrypt (`src/sites/wire.ts:224-260`).

Refused tokens (designs/2026-10-16-refused-tokens.md): a refusal (invalid_grant, revoked, a 401 or Graph 190 on the who-am-I probe, or on another route when the probe with the same bearer is refused too) is kept by name, site, account, since when, the site's words and a hash of the value, in `refused-tokens.json` in the state dir. While the kept value matches that hash, calls get the 409 (`need_login`) with no call to the site. The first of an incident is one ops-lane line; later calls add nothing. A refused name is due at once: the desk queues `renew {names}` for it (keyed by name and since), and the daily renew probes every site first and makes it again too. The call whose own token was refused waits for that re-make under the same key, then runs once more, so a post costs a minute instead of failing; a re-make that fails leaves the 409 terminal. One try a day, marked before the setup runs, so a hung consent page costs a day, not a loop. Two failed days and renew stops with one ping saying the setup a person runs; a setup that makes it, or a call that works, ends the incident. `site revoke` is the only way our code ends a grant, and it marks every name the grant covered, so their re-make is queued in the same call.

## Shape

- `accountEnv(name, account)` = the per-account name — `src/sites/oauth.ts:80`; `accessTokens(http, env, now, keep, shared)`, `MintedTokens`, `fileMintedTokens` — `:125-260`; `runConsent` — `:203`; `pkcePair`, `codeFrom` — `:74,148`; `WEB_REDIRECT` (the https redirect Meta and Instagram register; TikTok registers wren's portal callback, `TIKTOK_REDIRECT` in `src/sites/tiktok.ts`) — `:71`
- Renewal: `RENEW_WITHIN_MS` 14 days, `Renewal`, `RenewalPlan`, `renewals` (lapsing + refused), `renewDue`, `renewWording`, `nextLapse` — `src/sites/renew.ts:21-188`
- Refused: `TokenRefused { token, why, site, account }` — `src/sites/oauth.ts:102`; `revokeGrant` — `src/sites/oauth.ts:191`; `RefusedToken`, `RefusedTokens { list, refuse, claim, start, end, stale, clear }`, `GIVE_UP_DAYS` 2, `dueToday`, `fileRefusedTokens`, `refusedLine` — `src/sites/refused.ts:13-180`; kept and said in `sitesFor` (`record`, `withRenew`, `revoke`) — `src/sites/wire.ts:232-408`; queued and awaited by `sitesService` (`queueRemake`, `awaitRemake`, `call`, `revoke`) — `src/sites/service.ts:95-140`; `mintedTokensFor` — `src/app/services.ts`; notices via `opsLane` — `src/app/ops.ts`
- Store: `SecretSink.put(name, value, o)` — `src/deps/sink.ts:9-12`; `envStoreFor` / `sinkFor` (SSM `/autobrowse/config` via credvault `EnvStore`, `.env` locally) — `src/app/services-keys.ts:28`; `autobrowse env` (`src/app/cli-env.ts`)
- Not a token: an API key kept as a credential `<vendor>@<label>` ([[credential]]). Four handlers of `sitesService` serve those to wren's Accounts page (`keys`, `keySpend`, `keyRevoke`, `keyRotate`, `keysHere` / `keyCall` in `src/sites/service.ts`; shapes in `src/sites/keys.ts`); `keyRotate` starts a run, it mints nothing itself
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

- Source: `src/oauth/providers.ts`, `src/sites/oauth.ts`, `src/sites/renew.ts`, `src/sites/refused.ts`
- Design: `designs/2026-09-21-site-apis.md`, `designs/2026-10-16-refused-tokens.md`
- Tests: `test/refused-tokens.test.ts`, `test/x.test.ts`
