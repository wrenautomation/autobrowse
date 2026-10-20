---
type: object
cluster: pieces
universe: live
status: verified
verified: 2026-10-20 @ 3bb9f65
entity: src/oauth/index.ts
---

# OAuth piece

The `./oauth` subpath: the wire of every OAuth sign-in, as a pure library. One providers table, the code exchange and refresh per provider, Meta's user token and Pages, a who-am-I read per social platform, mail sign-in (Google, Microsoft) and connected-app sign-in (a spec as argument). wren imports it; autobrowse's own site specs read their URLs from the table.

## Why this shape

wren's four OAuth copies (core, social connect, mail, connected apps) and autobrowse's site specs wrote the same URLs and the same token calls. A piece takes a `fetch`, the app's id and secret, codes and tokens, and returns token JSON or an `OAuthError`. No env names, files, browser or Restate. What a token means to a product (what to store, which Page to pick, UI copy) stays with the caller. The two error parsers stay two: `tokenPost`/`oauthErrorOf` for mail and connected apps, `platformJson`/`platformErrorOf` for the social platforms; a caller keeps its own, so every error (class, `code`, `revoked`, message) is what wren sends today. `test/pieces.test.ts` fails if any file it reaches imports Playwright, `src/browser`, `src/app` or `src/sites`.

## Shape

- `OAUTH_PROVIDERS` (google, microsoft, meta, linkedin, x, tiktok, instagram, threads), `authorizeUrl`, `authorizeEndpoint`, `tokenEndpoint`, `tenantOf` — `src/oauth/providers.ts:38,130,122,126,112`
- `randomState`, `pkceVerifier`, `pkceChallenge`, `OAuthError`, `revokedCode`, `oauthErrorOf`, `tokenPost`, `claimsOf` — `src/oauth/core.ts:15-92`
- `platformErrorOf`, `platformJson`, `exchangeCode`, `refreshGrant`, `metaUserToken`, `metaPages`, `whoAmI`, `SOCIAL_PROVIDER` — `src/oauth/platform.ts:75,98,152,172,190,220,241`
- `mailConnectUrl`, `mailConsentUrl`, `mailExchange`, `mailRefresh`, `appInTenant`, `scopesFor`, `accessOf` — `src/oauth/mail.ts:51-169`
- `appConnectUrl`, `appExchange`, `appRefresh`, `AppSpec`, `AppTokens` — `src/oauth/apps.ts:11-81`
- Exports — `src/oauth/index.ts`; test — `test/oauth.test.ts`
- Not here: the consent driver, the mint cache, `accessTokens`, `revokeGrant` (`src/sites/oauth.ts`); re-consent planning (`src/sites/renew.ts`)

## Connected to

- **owns:** the providers table and every OAuth token call that needs no browser
- **joins:** [[token]] (`pkcePair` is built on the piece; each site's `OAuthSpec` reads `authorizeUrl` and `tokenUrl` from the table), [[site-api]], [[mail-piece]] and [[google-piece]] (same rules), `test/pieces.test.ts` (the purity check)
- **looks-like-but-is-not:** `accessTokens` in `src/sites/oauth.ts`, which mints and caches through `HttpClient` and `TokenRefused`

## If you change this

- **Hits:** wren's `core/oauth`, social connect, mail access and connectors sign-in (outside the tree); the ten site specs' URLs (`src/sites/{gmail,drive,youtube,linkedin,x,tiktok,meta,instagram,threads,outlook}.ts`); `scripts/build-check.mjs` (entry names), `package.json` `exports`
- **Does not hit:** how autobrowse mints, retries or reports a refused token; `src/sites/renew.ts`

## Surfaces

| Surface | Role |
|---|---|
| wren | imports the calls; keeps scopes, labels, copy and the stored token rows |
| autobrowse site specs | read the provider URLs from the table |

## See

- Source: `src/oauth/index.ts`
- Design: the wren repo doc designs/2026-10-20-autobrowse-pieces.md
